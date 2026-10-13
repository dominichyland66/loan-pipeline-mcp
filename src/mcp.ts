import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Broker, Customer, ApplicationRow, ApplicationEvent, StatusCount } from "./db.js";
import { STATUSES, LABELS, PIPELINE_TEXT } from "./pipeline.js";
import {
  brokersTable, brokerCard, customersTable, customerCard,
  applicationsTable, searchTable, applicationCard, pipelineTable,
} from "./format.js";

const INSTRUCTIONS = `You manage a lender's loan application pipeline. Applications come in from brokers (introducers) or directly.
Entities: customers (a person; business borrowers also have a company_name), brokers (person + firm), applications
(one loan request: personal or business, amount in GBP, term in months, purpose, broker, status) and each application's
event history (every status change with who did it and a note).
Pipeline (status ids): ${PIPELINE_TEXT}
Workflow:
- Resolve names first: find_customers (matches person or company), find_brokers (matches broker or firm). Use the ids.
- One customer's applications: list_applications. Across customers ("what is awaiting underwriting?", "what has
  Northgate sent us this month?", "show declined business loans"): search_applications. Overview of volumes: pipeline_summary.
- One application's story ("what happened to application 7?", "why was it declined?"): get_application, which includes the history.
- Moving an application on ("KYC passed for app 3", "underwriter approved it"): advance_application with the status id.
  Only the allowed next moves are accepted; if a move is rejected the error lists what is allowed, so tell the user.
- New application: a business loan needs a customer with a company_name; create a new business borrower with company_name set.
  "£25k over 5 years" = amount 25000, term_months 60. Amounts are GBP.
Dates: "last month" means since = today minus 30 days; "this week" = 7 days.
Presentation: tool results contain a ready-made Markdown table. Show it as-is, with a one-line summary above it that
answers the question (e.g. "Three applications worth £175,000 are awaiting an underwriter decision."). Use the Totals line.
Always confirm with the user before delete_customer, delete_application, delete_broker, and before moving an application
to declined or withdrawn.`;

const StatusSchema = z.enum(STATUSES);
const LoanTypeSchema = z.enum(["personal", "business"]);
const statusList = STATUSES.map((s) => `${s} (${LABELS[s]})`).join(", ");

const BrokerShape = z.object({ id: z.number(), name: z.string(), firm: z.string(), email: z.string().nullable(), created_at: z.string() });
const CustomerShape = z.object({
  id: z.number(), name: z.string(), email: z.string().nullable(), company_name: z.string().nullable(), created_at: z.string(),
});
const ApplicationShape = z.object({
  id: z.number(), customer_id: z.number(), broker_id: z.number().nullable(), type: LoanTypeSchema,
  amount: z.number(), term_months: z.number(), purpose: z.string(), status: StatusSchema,
  created_at: z.string(), updated_at: z.string(),
  customer_name: z.string(), company_name: z.string().nullable(), broker_name: z.string().nullable(), broker_firm: z.string().nullable(),
});
const EventShape = z.object({
  id: z.number(), application_id: z.number(), from_status: StatusSchema.nullable(), to_status: StatusSchema,
  actor: z.string().nullable(), note: z.string().nullable(), created_at: z.string(),
});

/**
 * Builds an MCP server whose tools call the REST API over HTTP.
 * The MCP layer is deliberately thin: it knows nothing about SQLite,
 * only about the API contract. `apiBase` is the API's own base URL,
 * e.g. http://localhost:3000/api.
 */
export function createMcpServer(apiBase: string): McpServer {
  const server = new McpServer({ name: "loan-pipeline", version: "2.0.0" }, { instructions: INSTRUCTIONS });

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) {
      const detail = data.message ?? data.error ?? res.statusText;
      throw new Error(`API ${method} ${path} failed (${res.status}): ${detail}`);
    }
    return data as T;
  }

  const query = (params: Record<string, string | number | boolean | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    return qs.size ? `?${qs}` : "";
  };

  const text = (markdown: string, structured?: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: markdown }],
    ...(structured ? { structuredContent: structured } : {}),
  });

  const error = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

  const wrap = <A>(fn: (args: A) => Promise<ReturnType<typeof text>>) => async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return error((err as Error).message);
    }
  };

  const since = z.string().optional().describe("Only applications received on/after this ISO date, e.g. '2026-09-13'");
  const until = z.string().optional().describe("Only applications received on/before this ISO date");

  // --- Customers -------------------------------------------------------------

  server.registerTool(
    "find_customers",
    {
      title: "Find customers",
      description:
        "Search customers by partial, case-insensitive person name or company name. Use this first to resolve " +
        "'Patel Engineering' or 'Mary Brown' to a customer id. Call with no search term to list every customer. " +
        "Business borrowers have a company_name; personal borrowers do not. Returns a Markdown table.",
      inputSchema: { search: z.string().optional().describe("Part of the person's or company's name, e.g. 'patel'") },
      outputSchema: { kind: z.literal("customers"), customers: z.array(CustomerShape) },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ search }) => {
      const customers = await call<Customer[]>("GET", `/customers${query({ search })}`);
      return text(customersTable(customers), { kind: "customers", customers });
    }),
  );

  server.registerTool(
    "add_customer",
    {
      title: "Add customer",
      description:
        "Create a customer. For a business borrower pass company_name (the person is the contact/director); " +
        "leave it out for a personal borrower. Returns the created customer including its id.",
      inputSchema: {
        name: z.string().min(1).describe("Person's full name, e.g. 'Sam Patel'"),
        email: z.string().email().optional().describe("Optional email address"),
        company_name: z.string().min(1).optional().describe("Company name for business loans, e.g. 'Patel Engineering Ltd'. Omit for personal loans."),
      },
    },
    wrap(async ({ name, email, company_name }) => {
      const c = await call<Customer>("POST", "/customers", { name, email, company_name });
      return text(`Created customer #${c.id}.\n\n${customerCard(c)}`);
    }),
  );

  server.registerTool(
    "update_customer",
    {
      title: "Update customer",
      description:
        "Change a customer's name, email and/or company name. Only the fields you pass are changed. " +
        "Pass an empty string to clear email or company_name. Returns the updated customer.",
      inputSchema: {
        customer_id: z.number().int().positive().describe("Customer id from find_customers"),
        name: z.string().min(1).optional().describe("New full name"),
        email: z.string().optional().describe("New email address, or '' to clear"),
        company_name: z.string().optional().describe("New company name, or '' to clear (makes them a personal borrower)"),
      },
      annotations: { idempotentHint: true },
    },
    wrap(async ({ customer_id, name, email, company_name }) => {
      if (name === undefined && email === undefined && company_name === undefined) throw new Error("Provide a new name, email and/or company_name.");
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (email !== undefined) body.email = email === "" ? null : email;
      if (company_name !== undefined) body.company_name = company_name === "" ? null : company_name;
      const c = await call<Customer>("PATCH", `/customers/${customer_id}`, body);
      return text(`Updated customer #${c.id}.\n\n${customerCard(c)}`);
    }),
  );

  server.registerTool(
    "delete_customer",
    {
      title: "Delete customer",
      description: "Permanently delete a customer and all of their applications and history. Confirm with the user before calling.",
      inputSchema: { customer_id: z.number().int().positive().describe("Customer id from find_customers") },
      annotations: { destructiveHint: true },
    },
    wrap(async ({ customer_id }) => {
      await call("DELETE", `/customers/${customer_id}`);
      return text(`Deleted customer #${customer_id} and their applications.`);
    }),
  );

  // --- Brokers ---------------------------------------------------------------

  server.registerTool(
    "find_brokers",
    {
      title: "Find brokers",
      description:
        "Search brokers (introducers) by partial broker name or firm name, e.g. 'northgate' or 'khan'. " +
        "Call with no search term to list every broker. Returns a Markdown table with ids.",
      inputSchema: { search: z.string().optional().describe("Part of the broker's or firm's name") },
      outputSchema: { kind: z.literal("brokers"), brokers: z.array(BrokerShape) },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ search }) => {
      const brokers = await call<Broker[]>("GET", `/brokers${query({ search })}`);
      return text(brokersTable(brokers), { kind: "brokers", brokers });
    }),
  );

  server.registerTool(
    "add_broker",
    {
      title: "Add broker",
      description: "Register a new broker (introducer): the person and the firm they work for. Returns the broker including its id.",
      inputSchema: {
        name: z.string().min(1).describe("Broker's full name, e.g. 'Alice Khan'"),
        firm: z.string().min(1).describe("Brokerage firm, e.g. 'Northgate Finance'"),
        email: z.string().email().optional().describe("Optional email address"),
      },
    },
    wrap(async ({ name, firm, email }) => {
      const b = await call<Broker>("POST", "/brokers", { name, firm, email });
      return text(`Created broker #${b.id}.\n\n${brokerCard(b)}`);
    }),
  );

  server.registerTool(
    "delete_broker",
    {
      title: "Delete broker",
      description: "Delete a broker. Their applications are kept and become direct applications. Confirm with the user before calling.",
      inputSchema: { broker_id: z.number().int().positive().describe("Broker id from find_brokers") },
      annotations: { destructiveHint: true },
    },
    wrap(async ({ broker_id }) => {
      await call("DELETE", `/brokers/${broker_id}`);
      return text(`Deleted broker #${broker_id}.`);
    }),
  );

  // --- Applications ----------------------------------------------------------

  server.registerTool(
    "pipeline_summary",
    {
      title: "Pipeline summary",
      description:
        "How many applications sit at each stage of the pipeline and the total amount requested at each, plus open vs closed totals. " +
        "Use for 'how is the pipeline looking?' or 'how much is awaiting underwriting?'.",
      inputSchema: {},
      outputSchema: { kind: z.literal("pipeline"), summary: z.array(z.object({ status: StatusSchema, count: z.number(), total_amount: z.number() })) },
      annotations: { readOnlyHint: true },
    },
    wrap(async () => {
      const { summary } = await call<{ summary: StatusCount[] }>("GET", "/pipeline");
      return text(pipelineTable(summary), { kind: "pipeline", summary });
    }),
  );

  server.registerTool(
    "list_applications",
    {
      title: "List a customer's applications",
      description:
        "All loan applications for one customer, newest first, as a Markdown table with totals. " +
        `Optionally filter to one status. Status ids: ${statusList}.`,
      inputSchema: {
        customer_id: z.number().int().positive().describe("Customer id from find_customers"),
        status: StatusSchema.optional().describe("Only applications currently in this status"),
      },
      outputSchema: { kind: z.literal("applications"), customer: CustomerShape, applications: z.array(ApplicationShape) },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ customer_id, status }) => {
      const [customer, applications] = await Promise.all([
        call<Customer>("GET", `/customers/${customer_id}`),
        call<ApplicationRow[]>("GET", `/customers/${customer_id}/applications${query({ status })}`),
      ]);
      return text(applicationsTable(applications, customer, { status }), { kind: "applications", customer, applications });
    }),
  );

  server.registerTool(
    "search_applications",
    {
      title: "Search applications across all customers",
      description:
        "Search loan applications across every customer, newest first, as a Markdown table with totals and a per-broker " +
        "breakdown. Answers 'what is awaiting an underwriter?', 'which business loans were declined?', 'what has Northgate " +
        "Finance introduced this month?', 'show everything still open'. Filters are optional and combine. " +
        `Status ids: ${statusList}.`,
      inputSchema: {
        status: StatusSchema.optional().describe("Only applications currently in this status"),
        open: z.boolean().optional().describe("true = only applications that are still in progress (not funded/declined/failed/withdrawn)"),
        customer: z.string().optional().describe("Partial customer or company name, e.g. 'patel'"),
        broker: z.string().optional().describe("Partial broker or firm name, e.g. 'northgate'"),
        type: LoanTypeSchema.optional().describe("'personal' or 'business'"),
        since,
        until,
      },
      outputSchema: {
        kind: z.literal("search"),
        filters: z.record(z.string(), z.union([z.string(), z.boolean()])),
        applications: z.array(ApplicationShape),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async (args) => {
      const applications = await call<ApplicationRow[]>("GET", `/applications${query(args)}`);
      const filters = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)) as Record<string, string | boolean>;
      return text(searchTable(applications, filters), { kind: "search", filters, applications });
    }),
  );

  server.registerTool(
    "get_application",
    {
      title: "Get one application with its history",
      description:
        "Full details of one application plus its complete status history (date, status, who, note) and the moves " +
        "allowed next. Use for 'what happened to application 7?', 'why was it declined?', 'how long has it been with the underwriter?'.",
      inputSchema: { application_id: z.number().int().positive().describe("Application id from list/search_applications") },
      outputSchema: { kind: z.literal("application"), application: ApplicationShape, events: z.array(EventShape) },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ application_id }) => {
      const { events, ...application } = await call<ApplicationRow & { events: ApplicationEvent[] }>("GET", `/applications/${application_id}`);
      return text(applicationCard(application, events), { kind: "application", application, events });
    }),
  );

  server.registerTool(
    "add_application",
    {
      title: "Add a loan application",
      description:
        "Record a new loan application for a customer; it starts at 'received'. '£25k over 5 years for a van' is " +
        "amount 25000, term_months 60, purpose 'van'. Type defaults from the customer (company_name set = business); " +
        "a business application requires the customer to have a company_name. Pass broker_id when a broker introduced it, " +
        "omit it for a direct application.",
      inputSchema: {
        customer_id: z.number().int().positive().describe("Customer id from find_customers"),
        amount: z.number().positive().describe("Amount requested in GBP, e.g. 25000"),
        term_months: z.number().int().positive().describe("Term in months, e.g. 60"),
        purpose: z.string().min(1).describe("What the loan is for, e.g. 'CNC machinery'"),
        broker_id: z.number().int().positive().optional().describe("Broker id from find_brokers; omit for direct"),
        type: LoanTypeSchema.optional().describe("'personal' or 'business'; defaults from the customer"),
        note: z.string().optional().describe("Optional note for the 'received' event"),
      },
    },
    wrap(async ({ customer_id, ...body }) => {
      const created = await call<ApplicationRow>("POST", `/customers/${customer_id}/applications`, body);
      const { events, ...a } = await call<ApplicationRow & { events: ApplicationEvent[] }>("GET", `/applications/${created.id}`);
      return text(`Created application #${a.id} for customer #${customer_id}.\n\n${applicationCard(a, events)}`);
    }),
  );

  server.registerTool(
    "advance_application",
    {
      title: "Move an application to its next status",
      description:
        "Record a status change on an application, e.g. KYC passed, AML passed, sent to the underwriter, approved, " +
        "declined, offer issued, funded, or withdrawn. Only the allowed next step is accepted; the error message lists " +
        `the valid moves if not. Pipeline: ${PIPELINE_TEXT} Pass who did it (actor) and a note (reason) where known. ` +
        "Confirm with the user before declined or withdrawn.",
      inputSchema: {
        application_id: z.number().int().positive().describe("Application id"),
        status: StatusSchema.describe(`New status id. One of: ${statusList}`),
        actor: z.string().optional().describe("Who made the decision, e.g. 'J. Underwriter', 'KYC service'"),
        note: z.string().optional().describe("Reason or comment, e.g. 'affordability: DSCR below 1.25x'"),
      },
    },
    wrap(async ({ application_id, ...body }) => {
      const { event, ...a } = await call<ApplicationRow & { event: ApplicationEvent }>("POST", `/applications/${application_id}/transition`, body);
      const events = await call<ApplicationRow & { events: ApplicationEvent[] }>("GET", `/applications/${application_id}`);
      return text(`Application #${a.id} moved from ${LABELS[event.from_status!]} to **${LABELS[event.to_status]}**.\n\n${applicationCard(a, events.events)}`);
    }),
  );

  server.registerTool(
    "update_application",
    {
      title: "Update application details",
      description:
        "Correct an application's amount, term, purpose and/or broker (not its status; use advance_application for that). " +
        "Only the fields you pass are changed. Pass broker_id 0 to make it a direct application.",
      inputSchema: {
        application_id: z.number().int().positive().describe("Application id"),
        amount: z.number().positive().optional().describe("New amount in GBP"),
        term_months: z.number().int().positive().optional().describe("New term in months"),
        purpose: z.string().min(1).optional().describe("New purpose"),
        broker_id: z.number().int().nonnegative().optional().describe("New broker id, or 0 for direct"),
      },
      annotations: { idempotentHint: true },
    },
    wrap(async ({ application_id, amount, term_months, purpose, broker_id }) => {
      if (amount === undefined && term_months === undefined && purpose === undefined && broker_id === undefined) {
        throw new Error("Provide a new amount, term_months, purpose and/or broker_id.");
      }
      const body: Record<string, unknown> = {};
      if (amount !== undefined) body.amount = amount;
      if (term_months !== undefined) body.term_months = term_months;
      if (purpose !== undefined) body.purpose = purpose;
      if (broker_id !== undefined) body.broker_id = broker_id === 0 ? null : broker_id;
      const a = await call<ApplicationRow>("PATCH", `/applications/${application_id}`, body);
      const { events } = await call<{ events: ApplicationEvent[] }>("GET", `/applications/${application_id}`);
      return text(`Updated application #${a.id}.\n\n${applicationCard(a, events)}`);
    }),
  );

  server.registerTool(
    "delete_application",
    {
      title: "Delete application",
      description: "Permanently delete one application and its history. Prefer advance_application to 'withdrawn' unless it was entered in error. Confirm with the user first.",
      inputSchema: { application_id: z.number().int().positive() },
      annotations: { destructiveHint: true },
    },
    wrap(async ({ application_id }) => {
      await call("DELETE", `/applications/${application_id}`);
      return text(`Deleted application #${application_id}.`);
    }),
  );

  return server;
}
