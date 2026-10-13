import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Builds an MCP server whose tools call the REST API over HTTP.
 * The MCP layer is deliberately thin: it knows nothing about SQLite,
 * only about the API contract. `apiBase` is the API's own base URL,
 * e.g. http://localhost:3000/api.
 */
export function createMcpServer(apiBase: string): McpServer {
  const server = new McpServer({ name: "customer-orders", version: "1.0.0" });

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

  const text = (value: unknown) => ({
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  });

  const error = (message: string) => ({
    content: [{ type: "text" as const, text: message }],
    isError: true,
  });

  const wrap = <A>(fn: (args: A) => Promise<unknown>) => async (args: A) => {
    try {
      return text(await fn(args));
    } catch (err) {
      return error((err as Error).message);
    }
  };

  // --- Customers -------------------------------------------------------------

  server.registerTool(
    "find_customers",
    {
      title: "Find customers",
      description:
        "Search customers by (partial, case-insensitive) name. Use this first to resolve a name such as " +
        "'Mr Jones' or 'Mary Brown' to a customer id before adding or listing orders. " +
        "Call with no search term to list every customer.",
      inputSchema: { search: z.string().optional().describe("Part of the customer's name, e.g. 'jones'") },
      annotations: { readOnlyHint: true },
    },
    wrap(({ search }) => call("GET", `/customers${search ? `?search=${encodeURIComponent(search)}` : ""}`)),
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
    wrap(({ name, email }) => call("POST", "/customers", { name, email })),
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
      return `Deleted customer ${customer_id} and their orders.`;
    }),
  );

  // --- Orders ----------------------------------------------------------------

  server.registerTool(
    "list_orders",
    {
      title: "List orders for a customer",
      description:
        "List a customer's orders, newest first. Optionally filter by product name and/or a date range " +
        "(ISO 8601, e.g. '2026-09-13' or '2026-09-13T00:00:00Z'). Each order has product, quantity, unit and created_at. " +
        "To answer 'how many bananas did X buy last month', filter by product='banana' and since=<a month ago>, then sum quantity.",
      inputSchema: {
        customer_id: z.number().int().positive().describe("Customer id from find_customers"),
        product: z.string().optional().describe("Partial product name filter, e.g. 'banana'"),
        since: z.string().optional().describe("Only orders created on/after this ISO date"),
        until: z.string().optional().describe("Only orders created on/before this ISO date"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(({ customer_id, product, since, until }) => {
      const qs = new URLSearchParams();
      if (product) qs.set("product", product);
      if (since) qs.set("since", since);
      if (until) qs.set("until", until);
      const query = qs.size ? `?${qs}` : "";
      return call("GET", `/customers/${customer_id}/orders${query}`);
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
    wrap(({ customer_id, product, quantity, unit }) =>
      call("POST", `/customers/${customer_id}/orders`, { product, quantity, unit }),
    ),
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
      return `Deleted order ${order_id}.`;
    }),
  );

  return server;
}
