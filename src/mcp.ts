import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Customer, Order } from "./db.js";
import { customersTable, customerCard, ordersTable, orderCard } from "./format.js";

const INSTRUCTIONS = `You manage a small customer and orders database.
Workflow: resolve people by name with find_customers before anything else; use the returned id for other tools.
Quantities: "2kg of apples" = product "apples", quantity 2, unit "kg". Countable items use unit "each".
Dates: list_orders accepts ISO dates; "last month" means since = today minus 30 days.
Presentation: tool results already contain a Markdown table. Show that table to the user as-is
(you may add a one-line summary above it), and when summing quantities use the Totals line.
Always confirm with the user before delete_customer.`;

// The MCP App widget (an HTML page rendered inside the chat by hosts that
// support MCP Apps). Built by scripts/build-widget.mjs into dist/widget.html.
const WIDGET_URI = "ui://customer-orders/table.html";
const WIDGET_PATH = path.join(process.cwd(), "dist", "widget.html");
let widgetHtml: string | undefined;
function loadWidget(): string {
  widgetHtml ??= fs.readFileSync(WIDGET_PATH, "utf8");
  return widgetHtml;
}

const CustomerShape = z.object({
  id: z.number(), name: z.string(), email: z.string().nullable(), created_at: z.string(),
});
const OrderShape = z.object({
  id: z.number(), customer_id: z.number(), product: z.string(), quantity: z.number(), unit: z.string(), created_at: z.string(),
});

/**
 * Builds an MCP server whose tools call the REST API over HTTP.
 * The MCP layer is deliberately thin: it knows nothing about SQLite,
 * only about the API contract. `apiBase` is the API's own base URL,
 * e.g. http://localhost:3000/api.
 */
export function createMcpServer(apiBase: string): McpServer {
  const server = new McpServer({ name: "customer-orders", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (data as { error?: string }).error ?? res.statusText;
      throw new Error(`API ${method} ${path} failed (${res.status}): ${detail}`);
    }
    return data as T;
  }

  const text = (markdown: string, structured?: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: markdown }],
    ...(structured ? { structuredContent: structured } : {}),
  });

  const error = (message: string) => ({
    content: [{ type: "text" as const, text: message }],
    isError: true,
  });

  const wrap = <A>(fn: (args: A) => Promise<ReturnType<typeof text>>) => async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return error((err as Error).message);
    }
  };

  // --- Customers -------------------------------------------------------------

  registerAppTool(
    server,
    "find_customers",
    {
      title: "Find customers",
      description:
        "Search customers by (partial, case-insensitive) name. Use this first to resolve a name such as " +
        "'Mr Jones' or 'Mary Brown' to a customer id before adding or listing orders. " +
        "Call with no search term to list every customer. Returns a Markdown table.",
      inputSchema: { search: z.string().optional().describe("Part of the customer's name, e.g. 'jones'") },
      outputSchema: { kind: z.literal("customers"), customers: z.array(CustomerShape) },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: WIDGET_URI } },
    },
    wrap(async ({ search }) => {
      const customers = await call<Customer[]>("GET", `/customers${search ? `?search=${encodeURIComponent(search)}` : ""}`);
      return text(customersTable(customers), { kind: "customers", customers });
    }),
  );

  server.registerTool(
    "add_customer",
    {
      title: "Add customer",
      description: "Create a new customer. Returns the created customer including its id.",
      inputSchema: {
        name: z.string().min(1).describe("Full name, e.g. 'Mary Brown'"),
        email: z.string().email().optional().describe("Optional email address"),
      },
    },
    wrap(async ({ name, email }) => {
      const c = await call<Customer>("POST", "/customers", { name, email });
      return text(`Created customer #${c.id}.\n\n${customerCard(c)}`);
    }),
  );

  server.registerTool(
    "update_customer",
    {
      title: "Update customer",
      description:
        "Change a customer's name and/or email. Only the fields you pass are changed. " +
        "Pass email as an empty string to remove it. Returns the updated customer.",
      inputSchema: {
        customer_id: z.number().int().positive().describe("Customer id from find_customers"),
        name: z.string().min(1).optional().describe("New full name"),
        email: z.string().optional().describe("New email address, or '' to clear"),
      },
      annotations: { idempotentHint: true },
    },
    wrap(async ({ customer_id, name, email }) => {
      if (name === undefined && email === undefined) throw new Error("Provide a new name and/or email.");
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (email !== undefined) body.email = email === "" ? null : email;
      const c = await call<Customer>("PATCH", `/customers/${customer_id}`, body);
      return text(`Updated customer #${c.id}.\n\n${customerCard(c)}`);
    }),
  );

  server.registerTool(
    "delete_customer",
    {
      title: "Delete customer",
      description: "Permanently delete a customer and all of their orders. Confirm with the user before calling.",
      inputSchema: { customer_id: z.number().int().positive().describe("Customer id from find_customers") },
      annotations: { destructiveHint: true },
    },
    wrap(async ({ customer_id }) => {
      await call("DELETE", `/customers/${customer_id}`);
      return text(`Deleted customer #${customer_id} and their orders.`);
    }),
  );

  // --- Orders ----------------------------------------------------------------

  registerAppTool(
    server,
    "list_orders",
    {
      title: "List orders for a customer",
      description:
        "List a customer's orders, newest first, as a Markdown table with per-product totals. " +
        "Optionally filter by product name and/or a date range (ISO 8601, e.g. '2026-09-13'). " +
        "To answer 'how many bananas did X buy last month', filter by product='banana' and since=<30 days ago> " +
        "and read the Totals line.",
      inputSchema: {
        customer_id: z.number().int().positive().describe("Customer id from find_customers"),
        product: z.string().optional().describe("Partial product name filter, e.g. 'banana'"),
        since: z.string().optional().describe("Only orders created on/after this ISO date"),
        until: z.string().optional().describe("Only orders created on/before this ISO date"),
      },
      outputSchema: {
        kind: z.literal("orders"),
        customer: CustomerShape,
        filters: z.object({ product: z.string().optional(), since: z.string().optional(), until: z.string().optional() }),
        orders: z.array(OrderShape),
      },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: WIDGET_URI } },
    },
    wrap(async ({ customer_id, product, since, until }) => {
      const qs = new URLSearchParams();
      if (product) qs.set("product", product);
      if (since) qs.set("since", since);
      if (until) qs.set("until", until);
      const query = qs.size ? `?${qs}` : "";
      const [customer, orders] = await Promise.all([
        call<Customer>("GET", `/customers/${customer_id}`),
        call<Order[]>("GET", `/customers/${customer_id}/orders${query}`),
      ]);
      const filters = { ...(product && { product }), ...(since && { since }), ...(until && { until }) };
      return text(ordersTable(orders, customer), { kind: "orders", customer, filters, orders });
    }),
  );

  server.registerTool(
    "add_order",
    {
      title: "Add order for a customer",
      description:
        "Record an order for a customer. '2kg of apples' is product='apples', quantity=2, unit='kg'. " +
        "Use unit 'each' for countable items like '3 bananas'.",
      inputSchema: {
        customer_id: z.number().int().positive().describe("Customer id from find_customers"),
        product: z.string().min(1).describe("Product name, singular or plural, e.g. 'apples'"),
        quantity: z.number().positive().describe("Numeric quantity, e.g. 2"),
        unit: z.string().min(1).default("each").describe("Unit such as 'kg', 'litre', 'each'"),
      },
    },
    wrap(async ({ customer_id, product, quantity, unit }) => {
      const o = await call<Order>("POST", `/customers/${customer_id}/orders`, { product, quantity, unit });
      return text(`Added order #${o.id} for customer #${customer_id}.\n\n${orderCard(o)}`);
    }),
  );

  server.registerTool(
    "update_order",
    {
      title: "Update order",
      description:
        "Change an existing order's product, quantity and/or unit. Only the fields you pass are changed. " +
        "Get the order_id from list_orders first. Returns the updated order.",
      inputSchema: {
        order_id: z.number().int().positive().describe("Order id from list_orders"),
        product: z.string().min(1).optional().describe("New product name"),
        quantity: z.number().positive().optional().describe("New quantity"),
        unit: z.string().min(1).optional().describe("New unit such as 'kg', 'litre', 'each'"),
      },
      annotations: { idempotentHint: true },
    },
    wrap(async ({ order_id, product, quantity, unit }) => {
      if (product === undefined && quantity === undefined && unit === undefined) {
        throw new Error("Provide a new product, quantity and/or unit.");
      }
      const body: Record<string, unknown> = {};
      if (product !== undefined) body.product = product;
      if (quantity !== undefined) body.quantity = quantity;
      if (unit !== undefined) body.unit = unit;
      const o = await call<Order>("PATCH", `/orders/${order_id}`, body);
      return text(`Updated order #${o.id}.\n\n${orderCard(o)}`);
    }),
  );

  server.registerTool(
    "delete_order",
    {
      title: "Delete order",
      description: "Delete a single order by id.",
      inputSchema: { order_id: z.number().int().positive() },
      annotations: { destructiveHint: true },
    },
    wrap(async ({ order_id }) => {
      await call("DELETE", `/orders/${order_id}`);
      return text(`Deleted order #${order_id}.`);
    }),
  );

  // --- MCP App widget ----------------------------------------------------------
  // Hosts that support MCP Apps (claude.ai, Claude Desktop) fetch this resource
  // and render it in an iframe next to the find_customers / list_orders result.
  // Other hosts ignore the _meta and just show the Markdown table.
  registerAppResource(server, "Customer orders table", WIDGET_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{ uri: WIDGET_URI, mimeType: RESOURCE_MIME_TYPE, text: loadWidget() }],
  }));

  return server;
}
