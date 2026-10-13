import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Router } from "express";
import { db } from "./db.js";
import { STATUSES, LABELS, TRANSITIONS, isOpen } from "./pipeline.js";
import { describeTools, INSTRUCTIONS } from "./mcp.js";

// Self-description of this system, served at GET /api/about and exposed to
// Claude through the explain_system tool, so "how is this built?" questions
// can be answered from the running code rather than from memory.
//
// Everything that can be read from the live system is read from it (SQLite
// schema, Express routes, registered MCP tools, pipeline definition, package
// versions, Railway environment). Only the architecture narrative and the
// design decisions are written by hand.

export const TOPICS = [
  "overview", "architecture", "stack", "data_model", "pipeline", "rest_api",
  "mcp_server", "mcp_tools", "deployment", "design_decisions", "runtime", "source",
] as const;
export type Topic = (typeof TOPICS)[number];

export interface AboutSection {
  topic: Topic;
  title: string;
  markdown: string;
  data: unknown;
}

const ROOT = process.cwd();
const readJson = (file: string) => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8")); } catch { return undefined; }
};
const pkg = readJson("package.json") ?? {};
const railwayJson = readJson("railway.json");
const REPO_URL = "https://github.com/dominichyland66/loan-pipeline-mcp";
const startedAt = new Date();

const esc = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|");
const table = (header: string[], rows: unknown[][]) =>
  [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n");

// --- Introspection -------------------------------------------------------------

interface Column { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
interface ForeignKey { from: string; table: string; to: string; on_delete: string }

const TABLE_NOTES: Record<string, string> = {
  brokers: "Introducers: the person and the firm they work for. Referenced by applications.",
  customers: "Borrowers. A business borrower has company_name set; a personal borrower leaves it NULL. postcode/latitude/longitude/area locate them for a map (geocoded via postcodes.io when set through the API).",
  applications: "One loan request. Current status lives here; the history lives in application_events.",
  application_events: "Append-only history: one row per status change with who did it and a note. The first row is the 'received' event.",
  access_log: "One row per HTTP request (except /health and /api/logs*): source, route, status, duration, and the number/time of SQL statements it caused. Pruned to the newest 20,000.",
  query_log: "One row per SQL statement run while handling a logged request: kind (SELECT/INSERT/...), table and duration.",
};

function schema() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as unknown as { name: string }[];
  return tables.map(({ name }) => {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all() as unknown as Column[];
    const fks = db.prepare(`PRAGMA foreign_key_list(${name})`).all() as unknown as ForeignKey[];
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as unknown as { n: number };
    return {
      name,
      note: TABLE_NOTES[name] ?? "",
      rows: n,
      columns: columns.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: !c.notnull && !c.pk,
        default: c.dflt_value,
        primary_key: Boolean(c.pk),
        references: fks.find((f) => f.from === c.name) ? `${fks.find((f) => f.from === c.name)!.table}.${fks.find((f) => f.from === c.name)!.to} (ON DELETE ${fks.find((f) => f.from === c.name)!.on_delete})` : null,
      })),
    };
  });
}

const ROUTE_NOTES: Record<string, string> = {
  "GET /pipeline": "Status definitions (label, allowed next) plus count and total £ per status",
  "GET /brokers": "List brokers; ?search= matches broker or firm name",
  "POST /brokers": "Create a broker { name, firm, email? }",
  "GET /brokers/:id": "One broker",
  "PATCH /brokers/:id": "Change any subset of name, firm, email",
  "DELETE /brokers/:id": "Delete a broker; their applications become direct (broker_id NULL)",
  "GET /customers": "List customers; ?search= matches person or company name",
  "POST /customers": "Create a customer { name, email?, company_name?, postcode? }; the postcode is geocoded (400 invalid_postcode if unknown)",
  "GET /customers/locations": "Every customer with postcode, latitude, longitude, area and application totals; ?type=&search=&located=true&format=geojson",
  "GET /customers/:id": "One customer",
  "PATCH /customers/:id": "Change any subset of name, email, company_name, postcode (null clears; a new postcode is geocoded)",
  "DELETE /customers/:id": "Delete a customer; cascades to their applications and events",
  "GET /customers/:id/applications": "A customer's applications, newest first; ?status= filters",
  "POST /customers/:id/applications": "Create an application in 'received' { amount, term_months, purpose, broker_id?, type?, note? }; business type requires company_name",
  "GET /applications": "Search across customers: ?status=&open=&customer=&broker=&type=&since=&until=",
  "GET /applications/:id": "One application with its full events history",
  "POST /applications/:id/transition": "Move to a new status { status, actor?, note? }; 409 invalid_transition lists allowed moves",
  "PATCH /applications/:id": "Change any subset of amount, term_months, purpose, broker_id (null = direct)",
  "DELETE /applications/:id": "Delete an application and its history",
  "GET /logs": "Recent requests from the access log: ?limit=&since=&until=&source=rest|tool|mcp&route=&detail=&status_min=",
  "GET /logs/summary": "Usage summary: totals, by source, busiest routes, per-tool calls, database activity per table, per-hour series, slowest requests",
  "GET /about": "This self-description, all topics",
  "GET /about/:topic": "One topic of the self-description",
};

function routes(api: Router) {
  const stack = (api as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }).stack;
  return stack
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route!.methods).map((m) => ({ method: m.toUpperCase(), path: `/api${l.route!.path}` })))
    .map((r) => ({ ...r, note: ROUTE_NOTES[`${r.method} ${r.path.slice(4)}`] ?? "(undocumented)" }));
}

// --- Sections -------------------------------------------------------------------

const FILES: [string, string][] = [
  ["src/pipeline.ts", "Statuses, display labels, icons and the allowed-transition map. Imported by db, api, format and mcp so there is one definition."],
  ["src/db.ts", "Opens SQLite (node:sqlite), creates tables, exports brokers/customers/applications query objects. transition() enforces the pipeline inside a transaction."],
  ["src/api.ts", "Express 5 Router for /api. zod schemas validate every body and query; errors are JSON {error, issues?}."],
  ["src/geocode.ts", "UK postcode lookup on postcodes.io (normalises the postcode, returns latitude/longitude and admin district), with a 4 s timeout."],
  ["src/format.ts", "Turns rows into Markdown tables (totals, per-broker breakdown, application card with history, customer locations)."],
  ["src/mcp.ts", "createMcpServer(apiBase): registers the MCP tools and the server instructions; every tool is an HTTP call to /api."],
  ["src/about.ts", "This self-description (introspects schema, routes, tools)."],
  ["src/metrics.ts", "AsyncLocalStorage request context and the SQLite instrumentation that times every statement and attributes it to the current request."],
  ["src/accesslog.ts", "Express middleware writing access_log/query_log rows on response finish, plus the queries behind /api/logs and /api/logs/summary."],
  ["src/seed.ts", "Demo data: 3 brokers, 6 customers, 12 applications with back-dated histories, one at each stage. Runs only on an empty database."],
  ["src/server.ts", "Wires it together: express.json, /, /health, /api, POST /mcp (new McpServer + stateless StreamableHTTPServerTransport per request)."],
  ["scripts/smoke-mcp.ts", "MCP client test that drives every tool, including the error paths, and cleans up after itself."],
  ["scripts/seed.ts", "Manual wrapper around seedIfEmpty()."],
  ["railway.json", "Railway build/start/healthcheck configuration."],
];

const DECISIONS: [string, string][] = [
  ["REST first, MCP on top", "The business logic has exactly one entry point, the REST API. MCP tools are thin HTTP clients of it, so anything Claude can do can be done (and tested) with curl, and the API can serve other clients unchanged."],
  ["One process, two protocols", "The API and the MCP server run in the same Node process. The MCP tools call the API over loopback (API_BASE defaults to http://127.0.0.1:PORT/api), which keeps the split honest while needing only one deployment."],
  ["Stateless MCP transport", "Each POST /mcp builds a fresh McpServer and StreamableHTTPServerTransport with no session id. No in-memory session state means any number of replicas could serve requests, and a Railway redeploy loses nothing."],
  ["Built-in node:sqlite instead of better-sqlite3", "Railway's Nixpacks image has no Python or C toolchain, so native addons fail to compile. Node 24 ships SQLite in the standard library (DatabaseSync), which removes the build problem and the dependency."],
  ["Ephemeral database, reseeded per deploy", "This is a demo. Every deploy starts from an empty disk and seedIfEmpty() loads the sample pipeline, so the data is always in a known state. A Railway Volume plus DB_PATH would make it persistent."],
  ["Enforced transitions from one definition", "src/pipeline.ts holds the status list and the allowed-next map. The database layer refuses other moves, the API returns 409 with the allowed list, and the MCP tool schema and instructions are generated from the same table."],
  ["Append-only event history", "Status lives on the application for fast filtering, but every change is also written to application_events with actor and note. That is what answers 'why was it declined?' and 'how long was it with the underwriter?'."],
  ["Broker on the application, not the customer", "A customer can be introduced by different brokers over time, and broker reporting is per deal, so broker_id sits on applications. Deleting a broker sets it NULL (direct) rather than deleting deals."],
  ["Business vs personal via company_name", "A customer with company_name is a business borrower. An application's type defaults from that, and the API refuses a business application for a customer without a company."],
  ["Postcodes geocoded at write time", "Every customer carries a real UK postcode plus latitude, longitude and area so the book can be plotted on a map. Coordinates are resolved once, when the postcode is set, by calling postcodes.io (free, no key) from the API; reads never touch the network and the seed ships its own coordinates. An unknown postcode is rejected with 400 so bad locations never enter the data. GET /api/customers/locations (JSON or GeoJSON) and the customer_locations tool return the points with each customer's application totals."],
  ["Markdown tables in tool results", "Tools return a ready-made Markdown table plus structuredContent. Claude Desktop renders the Markdown directly, so answers arrive formatted without the model retyping rows. An earlier interactive-widget version (MCP Apps) was removed because rendering was unreliable."],
  ["Server instructions", "The MCP initialize response carries instructions describing the pipeline, how to chain tools, how to parse '£25k over 5 years', and when to confirm before destructive actions."],
  ["Access logging inside the same database", "Every request to /api and /mcp is timed and written to access_log, with the SQL statements it caused in query_log (attributed through AsyncLocalStorage, so no code in the handlers changes). It answers 'how busy is the API and the database?' from the service itself; /health and /api/logs* are excluded so monitoring does not inflate the numbers. Like the rest of the data it is ephemeral on Railway."],
  ["No authentication", "Deliberate for the demo: anyone with the /mcp URL can read and write. A real deployment would put OAuth or an API key in front of /mcp and /api."],
];

function sections(api: Router): Record<Topic, AboutSection> {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } as Record<string, string>;
  const sch = schema();
  const rts = routes(api);
  const tools = describeTools();
  const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const commit = process.env.RAILWAY_GIT_COMMIT_SHA;

  const overview: AboutSection = {
    topic: "overview", title: "Overview",
    data: { name: pkg.name, version: pkg.version, repo: REPO_URL, public_url: publicDomain ? `https://${publicDomain}` : null },
    markdown:
      `**${pkg.name} ${pkg.version}** is a demo of an MCP server layered over a plain REST API. The domain is a lender's ` +
      `loan application pipeline: brokers introduce applications from personal and business borrowers, and each application ` +
      `moves through KYC, AML and underwriting to an offer and funding, with every status change recorded.\n\n` +
      "```\nClaude Desktop ──(MCP, Streamable HTTP)──▶ POST /mcp ──(HTTP)──▶ /api ──▶ SQLite\n```\n\n" +
      `One Node/TypeScript process serves the REST API (/api), the MCP server (/mcp) and a health check (/health). ` +
      `Source: ${REPO_URL}${publicDomain ? `. Running at https://${publicDomain}` : ""}.`,
  };

  const architecture: AboutSection = {
    topic: "architecture", title: "Architecture and request flow",
    data: {
      layers: ["Claude Desktop (MCP client)", "POST /mcp: StreamableHTTPServerTransport + McpServer, created per request", "Tool handler (src/mcp.ts): fetch() to the REST API", "Express router (src/api.ts): zod validation", "Query layer (src/db.ts)", "SQLite via node:sqlite"],
      api_base_env: "API_BASE (default http://127.0.0.1:PORT/api)",
    },
    markdown:
      "A question like *\"what is awaiting an underwriter?\"* flows through these layers:\n\n" +
      "1. **Claude Desktop** holds the server's instructions and tool list from the MCP `initialize` handshake and decides to call `search_applications(status=\"awaiting_underwriter\")`.\n" +
      "2. **POST /mcp** (src/server.ts) receives the JSON-RPC request. A new `McpServer` and a stateless `StreamableHTTPServerTransport` are created for that one request and closed when the response ends.\n" +
      "3. The **tool handler** (src/mcp.ts) validates arguments with zod, then calls the REST API over HTTP: `GET /api/applications?status=awaiting_underwriter`. The tool layer knows nothing about SQLite.\n" +
      "4. The **Express router** (src/api.ts) validates the query with zod and calls `applications.search()`.\n" +
      "5. The **query layer** (src/db.ts) runs one SQL statement joining applications, customers and brokers.\n" +
      "6. The rows come back up the stack; **format.ts** renders a Markdown table with totals and a per-broker breakdown, which is returned as the tool's text content alongside `structuredContent`.\n" +
      "7. Claude shows the table with a one-line summary, as the server instructions ask.\n\n" +
      "Each hop is logged: the access-log middleware (src/accesslog.ts) times every request to /mcp and /api and records the SQL statements it caused, so one tool call shows up once as source `mcp` (Claude → /mcp) and once as source `tool` (the tool → /api, tagged with the tool name via an x-mcp-tool header).\n\n" +
      "Writes follow the same path. `advance_application` posts to `/api/applications/:id/transition`; the database layer checks the move against the pipeline definition inside a transaction, updates the status and appends an event, or the API answers 409 with the allowed moves and the tool relays that message.",
  };

  const stack: AboutSection = {
    topic: "stack", title: "Technology stack",
    data: { node: process.version, engines: pkg.engines, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, module_type: pkg.type },
    markdown:
      table(["Component", "Choice", "Version / note"], [
        ["Runtime", "Node.js", `${process.version} (engines: ${pkg.engines?.node ?? "?"}), ES modules`],
        ["Language", "TypeScript", `${deps.typescript ?? "?"}, compiled with tsc to dist/`],
        ["HTTP server", "Express", deps.express ?? "?"],
        ["Validation", "zod", `${deps.zod ?? "?"} (API bodies/queries and MCP tool schemas)`],
        ["MCP", "@modelcontextprotocol/sdk", `${deps["@modelcontextprotocol/sdk"] ?? "?"}, McpServer + StreamableHTTPServerTransport`],
        ["Database", "SQLite via node:sqlite", "built into Node, no native addon; WAL mode, foreign keys on"],
        ["Dev tooling", "tsx", `${deps.tsx ?? "?"} for npm run dev / seed / smoke`],
        ["Hosting", "Railway", "Nixpacks build, see deployment"],
      ]),
  };

  const data_model: AboutSection = {
    topic: "data_model", title: "Data model",
    data: sch,
    markdown:
      sch.map((t) =>
        `**${t.name}** (${t.rows} rows)${t.note ? `: ${t.note}` : ""}\n\n` +
        table(["Column", "Type", "Nullable", "Default", "References"], t.columns.map((c) => [
          c.primary_key ? `${c.name} (PK)` : c.name, c.type, c.nullable ? "yes" : "no", c.default ?? "", c.references ?? "",
        ])),
      ).join("\n\n") +
      "\n\nRelationships: a customer has many applications; a broker has many applications (nullable, SET NULL on delete); an application has many events (CASCADE on delete). Deleting a customer removes their applications and events.",
  };

  const pipeline: AboutSection = {
    topic: "pipeline", title: "Status pipeline",
    data: STATUSES.map((s) => ({ status: s, label: LABELS[s], open: isOpen(s), next: TRANSITIONS[s] })),
    markdown:
      "Defined once in src/pipeline.ts and enforced in `applications.transition()`. A move that is not in the allowed list is refused (API 409 `invalid_transition`), and the response lists what is allowed.\n\n" +
      table(["Status id", "Label", "Open?", "Allowed next"], STATUSES.map((s) => [s, LABELS[s], isOpen(s) ? "yes" : "final", TRANSITIONS[s].join(", ") || "—"])) +
      "\n\nKYC and AML can each fail, which ends the application at that check. Withdrawn is allowed from any open status. A new application always starts at `received` and its first event is written at the same time.",
  };

  const rest_api: AboutSection = {
    topic: "rest_api", title: "REST API",
    data: rts,
    markdown:
      "Routes below are read from the live Express router. All bodies are JSON and validated with zod; validation failures return 400 `{error: \"validation_failed\", issues}`; missing records return 404 `{error: \"<thing>_not_found\"}`.\n\n" +
      table(["Method", "Path", "What it does"], rts.map((r) => [r.method, r.path, r.note])),
  };

  const mcp_server: AboutSection = {
    topic: "mcp_server", title: "What the MCP server actually is (the code)",
    data: {
      endpoint: "POST /mcp in src/server.ts",
      factory: "createMcpServer(apiBase) in src/mcp.ts",
      sdk: { package: "@modelcontextprotocol/sdk", version: deps["@modelcontextprotocol/sdk"] ?? null, classes: ["McpServer", "StreamableHTTPServerTransport"] },
      lifecycle: "new McpServer + new transport per request; both closed when the response ends",
      tool_count: tools.length,
      helpers: ["call(method, path, body): fetch to the REST API, adds x-mcp-tool header", "text(markdown, structured): builds the MCP result content", "wrap(fn): converts thrown errors into isError results"],
      handled_by_sdk: ["JSON-RPC framing", "initialize handshake (name, version, instructions)", "tools/list from the registered zod schemas", "tools/call dispatch and argument validation"],
    },
    markdown:
      "There is no separate MCP process or binary. The MCP server is **one Express route plus one factory function**, " +
      "running inside the same Node process as the REST API.\n\n" +
      "**1. The endpoint** is `POST /mcp` in src/server.ts. Each request gets a brand-new `McpServer` and a stateless " +
      "`StreamableHTTPServerTransport` from the official SDK; both are closed when the response finishes, so nothing is kept in memory between calls:\n\n" +
      "```ts\n" +
      "app.post(\"/mcp\", async (req, res) => {\n" +
      "  const server = createMcpServer(API_BASE);\n" +
      "  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });\n" +
      "  res.on(\"close\", () => { transport.close(); server.close(); });\n" +
      "  await server.connect(transport);\n" +
      "  await transport.handleRequest(req, res, req.body);\n" +
      "});\n" +
      "```\n\n" +
      "GET and DELETE on /mcp answer 405, because a stateless server has no sessions or server-initiated streams.\n\n" +
      "**2. The factory** `createMcpServer(apiBase)` in src/mcp.ts is what makes it an MCP server. It constructs an `McpServer` " +
      `with a name and the server instructions, then registers ${tools.length} tools. Every tool is a name, a description, a zod input schema, ` +
      "an optional output schema, annotations (read-only / destructive / idempotent hints) and an async handler:\n\n" +
      "```ts\n" +
      "const server = new McpServer({ name: \"loan-pipeline\", version: \"2.0.0\" }, { instructions: INSTRUCTIONS });\n\n" +
      "tool(\"find_customers\", {\n" +
      "  title: \"Find customers\",\n" +
      "  description: \"Search customers by partial, case-insensitive person name or company name...\",\n" +
      "  inputSchema: { search: z.string().optional() },\n" +
      "  outputSchema: { kind: z.literal(\"customers\"), customers: z.array(CustomerShape) },\n" +
      "  annotations: { readOnlyHint: true },\n" +
      "}, wrap(async ({ search }) => {\n" +
      "  const customers = await call<Customer[]>(\"GET\", `/customers${query({ search })}`);\n" +
      "  return text(customersTable(customers), { kind: \"customers\", customers });\n" +
      "}));\n" +
      "```\n\n" +
      "**3. Three small helpers** do the rest of the work inside the factory:\n\n" +
      "- `call(method, path, body)` is a thin `fetch` wrapper that hits the REST API at `apiBase` (loopback by default), " +
      "adds an `x-mcp-tool` header naming the running tool so the access log can attribute the API call, and throws with the API's error text on a non-2xx response.\n" +
      "- `text(markdown, structured)` returns the MCP result shape: a `content` array with one text item (a ready-made Markdown table) and optional `structuredContent` JSON.\n" +
      "- `wrap(fn)` catches anything the handler throws and returns it as an `isError` result, so a 409 invalid transition reaches Claude as a readable message rather than a protocol failure.\n\n" +
      "The tool handlers never touch SQLite. They only know the REST contract, which is why the whole MCP layer is a few hundred lines.\n\n" +
      "**4. What the SDK handles** so the repo does not have to: JSON-RPC framing over HTTP, the `initialize` handshake (which carries the " +
      "name, version and instructions), building the `tools/list` response from the registered zod schemas, and validating arguments and " +
      "dispatching `tools/call` to the right handler. The project's own code is only the tool definitions and the one route.\n\n" +
      "**5. Seeing it from the outside.** Claude Desktop (or any MCP client) is pointed at the public /mcp URL. The same tools can be exercised " +
      "without Claude by `npm run smoke`, which uses the SDK's client to call every tool against a running server.",
  };

  const mcp_tools: AboutSection = {
    topic: "mcp_tools", title: "MCP tools and instructions",
    data: { server: { name: "loan-pipeline", transport: "Streamable HTTP, stateless, POST /mcp" }, tools, instructions: INSTRUCTIONS },
    markdown:
      "Tools are read from the live MCP server. Each one is a thin wrapper over one or two REST calls and returns a Markdown table (plus structuredContent) or an `isError` message carrying the API's error text.\n\n" +
      table(["Tool", "Inputs", "Kind", "Purpose"], tools.map((t) => [t.name, t.inputs.join(", ") || "—", t.destructive ? "destructive" : t.readOnly ? "read-only" : "write", t.description])) +
      "\n\n**Server instructions** sent to Claude in the `initialize` response:\n\n```\n" + INSTRUCTIONS + "\n```",
  };

  const deployment: AboutSection = {
    topic: "deployment", title: "Deployment and configuration",
    data: {
      host: "Railway", railway_json: railwayJson, public_domain: publicDomain ?? null, git_commit: commit ?? null,
      env: { PORT: "listen port (Railway sets it)", DB_PATH: "SQLite file, default ./data/app.db", API_BASE: "where MCP tools reach the API, default loopback", SEED_DEMO_DATA: "'false' disables seeding an empty database" },
      mcp_connector_url: publicDomain ? `https://${publicDomain}/mcp` : "/mcp",
    },
    markdown:
      `Hosted on **Railway**, deployed from GitHub (${REPO_URL}, branch main) on every push. Nixpacks installs dependencies, ` +
      `runs \`${railwayJson?.build?.buildCommand ?? "npm run build"}\`, starts \`${railwayJson?.deploy?.startCommand ?? "npm start"}\` and health-checks \`${railwayJson?.deploy?.healthcheckPath ?? "/health"}\`.` +
      (publicDomain ? ` Public URL: https://${publicDomain}; MCP connector URL: https://${publicDomain}/mcp.` : "") +
      (commit ? ` Running commit ${commit.slice(0, 7)}.` : "") +
      "\n\nThe SQLite file is on the container's ephemeral disk, so **each deploy starts empty and is reseeded** with the demo pipeline. A Railway Volume mounted at /data with `DB_PATH=/data/app.db` would make data persistent.\n\n" +
      table(["Environment variable", "Meaning"], [
        ["PORT", "Listen port; Railway provides it (internal 8080)"],
        ["DB_PATH", "SQLite file path, default ./data/app.db"],
        ["API_BASE", "URL the MCP tools call, default http://127.0.0.1:PORT/api"],
        ["SEED_DEMO_DATA", "Set to false to skip seeding an empty database"],
      ]) +
      "\n\n**Connecting Claude Desktop:** Settings → Connectors → Add custom connector with the /mcp URL. There is no authentication. After the server's tools or instructions change, remove and re-add the connector so Desktop refreshes its cached tool list.",
  };

  const design_decisions: AboutSection = {
    topic: "design_decisions", title: "Design decisions and why",
    data: DECISIONS.map(([decision, why]) => ({ decision, why })),
    markdown: DECISIONS.map(([d, w]) => `- **${d}.** ${w}`).join("\n"),
  };

  const counts = Object.fromEntries(sch.map((t) => [t.name, t.rows]));
  const runtime: AboutSection = {
    topic: "runtime", title: "Runtime state",
    data: { node: process.version, platform: `${os.platform()} ${os.arch()}`, started_at: startedAt.toISOString(), uptime_seconds: Math.round(process.uptime()), db_path: process.env.DB_PATH ?? "./data/app.db", table_counts: counts, memory_rss_mb: Math.round(process.memoryUsage().rss / 1048576) },
    markdown:
      table(["Fact", "Value"], [
        ["Node", process.version], ["Platform", `${os.platform()} ${os.arch()}`],
        ["Started", startedAt.toISOString()], ["Uptime", `${Math.round(process.uptime())} s`],
        ["Database file", process.env.DB_PATH ?? "./data/app.db (default)"],
        ["Rows", Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(", ")],
        ["Memory (RSS)", `${Math.round(process.memoryUsage().rss / 1048576)} MB`],
      ]),
  };

  const source: AboutSection = {
    topic: "source", title: "Source layout",
    data: { repo: REPO_URL, files: FILES.map(([file, role]) => ({ file, role })), scripts: pkg.scripts },
    markdown:
      `Repository: ${REPO_URL}\n\n` + table(["File", "Role"], FILES) +
      "\n\n**npm scripts:** " + Object.entries(pkg.scripts ?? {}).map(([k, v]) => `\`${k}\` (${v})`).join(", "),
  };

  return { overview, architecture, stack, data_model, pipeline, rest_api, mcp_server, mcp_tools, deployment, design_decisions, runtime, source };
}

export function about(api: Router): AboutSection[] {
  const all = sections(api);
  return TOPICS.map((t) => all[t]);
}

export function aboutTopic(api: Router, topic: Topic): AboutSection {
  return sections(api)[topic];
}

/** Everything as one Markdown document. */
export function aboutMarkdown(sectionsToRender: AboutSection[]): string {
  return sectionsToRender.map((s) => `## ${s.title}\n\n${s.markdown}`).join("\n\n");
}
