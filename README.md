# Loan Pipeline API + MCP server

A small but realistic example of an MCP server layered over a plain REST API:
a lender's **loan application pipeline**, with brokers, personal and business
borrowers, and applications that move through KYC, AML and underwriting.

```
Claude Desktop ──(Streamable HTTP)──▶ /mcp ──(HTTP)──▶ /api ──▶ SQLite
```

One Node/TypeScript process serves both:

| Path     | What                                                      |
| -------- | --------------------------------------------------------- |
| `/api`   | Plain JSON REST API for brokers, customers, applications  |
| `/mcp`   | MCP server (stateless Streamable HTTP) whose tools call `/api` |
| `/health`| Health check used by Railway                              |

## The domain

- **Customers** are people. A business borrower also has a `company_name`
  (e.g. Sam Patel of *Patel Engineering Ltd*); personal borrowers leave it blank.
- **Brokers** (introducers) are a person plus the firm they work for. Each
  application records the broker who introduced it, or none for direct business.
- **Applications** are one loan request: `personal` or `business`, amount in
  GBP, term in months, purpose, broker and current status.
- **Events** record every status change with a timestamp, who did it and a note,
  so "why was application 9 declined?" has an answer.

### Pipeline

```
received ─▶ kyc_passed ─▶ aml_passed ─▶ awaiting_underwriter ─▶ approved ─▶ offer_issued ─▶ funded
   │             │                             │
   ▼             ▼                             ▼
kyc_failed   aml_failed                    declined              withdrawn (from any open status)
```

| Status id              | Shown as                       | Allowed next                              |
| ---------------------- | ------------------------------ | ----------------------------------------- |
| `received`             | Application Received           | kyc_passed, kyc_failed, withdrawn         |
| `kyc_passed`           | KYC Passed                     | aml_passed, aml_failed, withdrawn         |
| `aml_passed`           | AML Passed                     | awaiting_underwriter, withdrawn           |
| `awaiting_underwriter` | Awaiting Underwriter Decision  | approved, declined, withdrawn             |
| `approved`             | Approved                       | offer_issued, withdrawn                   |
| `offer_issued`         | Offer Issued                   | funded, withdrawn                         |
| `kyc_failed`, `aml_failed`, `declined`, `funded`, `withdrawn` | final | none |

Transitions are enforced by the API (`409 invalid_transition`, with the
allowed moves in the response), and `src/pipeline.ts` is the single definition
used by the database layer, the API and the MCP tool schemas.

## Run locally

```bash
npm install
npm run dev          # http://localhost:3000
npm run seed         # optional demo data (see below); the server also does this on an empty DB
npm run smoke        # drives every MCP tool through a real MCP client
```

Data lives in `./data/app.db` (override with `DB_PATH`). On startup, an empty
database is seeded with demo data (set `SEED_DEMO_DATA=false` to turn that off).

### Demo data

Three brokers (Northgate Finance, Reilly & Co Brokers, Castle Street Capital),
six customers (three personal, three businesses) and twelve applications with
back-dated histories, one at each stage:

| App | Customer                         | Loan                         | Broker          | Status                        |
| --: | -------------------------------- | ---------------------------- | --------------- | ----------------------------- |
|  1  | Mary Brown                       | £15,000 / 36 mo, home improvements | Northgate | Application Received          |
|  2  | Peter Jones                      | £8,000 / 24 mo, car          | Reilly & Co     | KYC Passed                    |
|  3  | Peter Jones                      | £12,000 / 36 mo, kitchen     | *direct*        | AML Passed                    |
|  4  | Patel Engineering Ltd            | £120,000 / 60 mo, CNC machinery | Northgate    | Awaiting Underwriter Decision |
|  5  | Helen Cartwright (personal)      | £10,000 / 48 mo, car         | Castle Street   | Approved                      |
|  6  | Patel Engineering Ltd            | £30,000 / 36 mo, van fleet   | Northgate       | Offer Issued                  |
|  7  | Cartwright Dental Practice Ltd   | £45,000 / 48 mo, refurbishment | Castle Street | Funded                        |
|  8  | Mary Brown                       | £3,000 / 12 mo, holiday (2 months ago) | Northgate | Funded                  |
|  9  | Greenfield Farms Ltd             | £250,000 / 84 mo, grain store | Castle Street  | Declined (DSCR 1.1x)          |
| 10  | Omar Siddiqui                    | £5,000 / 12 mo, consolidation | Reilly & Co    | KYC Failed (expired ID)       |
| 11  | Jack Greenfield (personal)       | £20,000 / 60 mo, Land Rover  | Reilly & Co     | AML Failed                    |
| 12  | Omar Siddiqui                    | £2,000 / 12 mo, laptop       | Reilly & Co     | Withdrawn                     |

## REST API

| Method | Path                                   | Body / query                                   |
| ------ | -------------------------------------- | ---------------------------------------------- |
| GET    | `/api/pipeline`                        | status definitions + count and £ per status    |
| GET    | `/api/about`                           | how the system is built: every topic as `{ topic, title, markdown, data }` |
| GET    | `/api/about/:topic`                    | one of overview, architecture, stack, data_model, pipeline, rest_api, mcp_tools, deployment, design_decisions, runtime, source |
| GET    | `/api/brokers?search=northgate`        | partial match on broker or firm name           |
| POST   | `/api/brokers`                         | `{ "name": "Alice Khan", "firm": "Northgate Finance", "email": "..." }` |
| GET/PATCH/DELETE | `/api/brokers/:id`           | PATCH any subset of name, firm, email; DELETE leaves their applications as direct |
| GET    | `/api/customers?search=patel`          | partial match on person or company name        |
| POST   | `/api/customers`                       | `{ "name": "Sam Patel", "email": "...", "company_name": "Patel Engineering Ltd" }` (omit company_name for personal) |
| GET/PATCH/DELETE | `/api/customers/:id`         | PATCH any subset; `null` clears email/company_name; DELETE cascades to applications |
| GET    | `/api/customers/:id/applications`      | `?status=funded`                               |
| POST   | `/api/customers/:id/applications`      | `{ "amount": 25000, "term_months": 60, "purpose": "Van", "broker_id": 1, "type": "business", "note": "..." }`; type defaults from the customer |
| GET    | `/api/applications`                    | `?status=&open=true&customer=&broker=&type=&since=&until=` across all customers |
| GET    | `/api/applications/:id`                | the application plus its `events` history      |
| POST   | `/api/applications/:id/transition`     | `{ "status": "approved", "actor": "J. Underwriter", "note": "..." }` → 409 if not allowed |
| PATCH  | `/api/applications/:id`                | any subset of amount, term_months, purpose, broker_id (`null` = direct) |
| DELETE | `/api/applications/:id`                |                                                |

```bash
curl -X POST localhost:3000/api/customers -H 'content-type: application/json' -d '{"name":"Ann Lee","company_name":"Lee Logistics Ltd"}'
curl -X POST localhost:3000/api/customers/7/applications -H 'content-type: application/json' -d '{"amount":40000,"term_months":48,"purpose":"Trailer","broker_id":1}'
curl -X POST localhost:3000/api/applications/13/transition -H 'content-type: application/json' -d '{"status":"kyc_passed","actor":"KYC service"}'
curl 'localhost:3000/api/applications?status=awaiting_underwriter'
```

## MCP tools

Every tool returns a ready-made **Markdown table** (with totals, and a
per-broker breakdown for searches), and the server sends Claude
**instructions** describing the pipeline and how to chain the tools.

| Tool                  | Purpose                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `find_customers`      | Resolve a person or company name to a customer id                     |
| `add_customer`        | Create a borrower (`company_name` for business)                       |
| `update_customer`     | Change name, email or company name                                    |
| `delete_customer`     | Delete a customer and their applications                              |
| `find_brokers`        | Resolve a broker or firm name to a broker id                          |
| `add_broker`          | Register a broker                                                     |
| `delete_broker`       | Delete a broker (their applications become direct)                    |
| `pipeline_summary`    | Applications and £ at each stage, open vs closed                      |
| `list_applications`   | One customer's applications, optionally by status                     |
| `search_applications` | Across customers: by status, open only, customer, broker, type, dates |
| `get_application`     | One application with its full history and allowed next moves          |
| `add_application`     | Record a new application (starts at `received`)                       |
| `advance_application` | Move an application to its next status, with actor and note           |
| `update_application`  | Correct amount, term, purpose or broker                               |
| `delete_application`  | Remove an application entered in error                                |
| `explain_system`      | How this server is built: architecture, stack, schema, routes, tools, deployment, design decisions |

### Self-description

`GET /api/about` (and the `explain_system` tool) describe the system from the
running code: the SQLite schema is read with `PRAGMA table_info`, the routes
from the live Express router, the tool list from the MCP server, the pipeline
from `src/pipeline.ts`, versions from `package.json` and the deploy details
from Railway's environment. Only the architecture narrative and the design
decisions (with their reasons) are written by hand, in `src/about.ts`. Ask
Claude "how is this built?", "what database is behind this?" or "why is the
MCP server layered over a REST API?".

## Deploy to Railway

1. Push this repo to GitHub, then in Railway: **New Project → Deploy from GitHub repo**.
   If the repo isn't listed, grant the Railway GitHub App access to it (GitHub →
   Settings → Applications → Railway → Configure → Repository access).
   `railway.json` sets the build (`npm run build`; Nixpacks installs dependencies itself), start (`npm start`) and health check.
2. Under **Settings → Networking → Generate Domain** to get a public URL. Railway sets `PORT` for you.
3. Check `https://<your-app>.up.railway.app/health` returns `{"ok":true}`.

The database is on the container's ephemeral disk, so **every deploy starts
fresh and is reseeded with demo data**. That's deliberate for a demo. If you
ever want data to survive deploys, add a Volume mounted at `/data` and set
`DB_PATH=/data/app.db`; seeding then only happens the first time.

## Connect Claude Desktop

**Custom connector (Pro, Max, Team, Enterprise):**
Settings → Connectors → Add custom connector → URL `https://<your-app>.up.railway.app/mcp`.
No auth is configured; anyone with the URL can read and write the data, which is fine for a demo.

**Alternative, any plan (needs Node on your Mac):** add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "loan-pipeline": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-app>.up.railway.app/mcp"]
    }
  }
}
```

Then try:

- "How is the pipeline looking?"
- "What's waiting for an underwriter decision?"
- "What has Northgate Finance sent us in the last month?"
- "Why was Greenfield Farms declined?"
- "KYC has passed on Mary Brown's application."
- "The underwriter has approved Patel Engineering's CNC machinery loan at 8.5%."
- "New business customer: Ann Lee of Lee Logistics Ltd, introduced by Tom Reilly, wants £40k over 4 years for a trailer."
- "Show me all open business loans."
- "Peter Jones has withdrawn his car loan application."
- "How is this system built, and why is the MCP server layered over a REST API?"

## Layout

```
src/pipeline.ts SQLite-independent pipeline definition: statuses, labels, allowed transitions
src/db.ts       SQLite schema + queries (built-in node:sqlite, no native build)
src/api.ts      Express router for /api
src/mcp.ts      MCP tools, each one an HTTP call to /api; server instructions
src/format.ts   Markdown table rendering for tool results
src/about.ts    self-description served at /api/about and by explain_system (introspects schema, routes, tools)
src/server.ts   Wires both into one Express app
src/seed.ts     demo data, applied automatically to an empty database
scripts/        seed.ts (manual seed), smoke-mcp.ts (MCP client test)
```
