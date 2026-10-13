# Customer & Orders API + MCP server

The smallest useful example of an MCP server layered over a plain REST API.

```
Claude Desktop ──(Streamable HTTP)──▶ /mcp ──(HTTP)──▶ /api ──▶ SQLite
```

One Node/TypeScript process serves both:

| Path     | What                                                      |
| -------- | --------------------------------------------------------- |
| `/api`   | Plain JSON REST API for customers and orders              |
| `/mcp`   | MCP server (stateless Streamable HTTP) whose tools call `/api` |
| `/health`| Health check used by Railway                              |

## Run locally

```bash
npm install
npm run dev          # http://localhost:3000
npm run seed         # optional demo data (Mary Brown, Peter Jones, Sam Patel)
npm run smoke        # drives every MCP tool through a real MCP client
```

Data lives in `./data/app.db` (override with `DB_PATH`).

## REST API

| Method | Path                               | Body / query                                   |
| ------ | ---------------------------------- | ---------------------------------------------- |
| GET    | `/api/customers?search=jones`      | optional partial, case-insensitive name search |
| POST   | `/api/customers`                   | `{ "name": "Mary Brown", "email": "..." }`     |
| GET    | `/api/customers/:id`               |                                                |
| DELETE | `/api/customers/:id`               | also deletes that customer's orders            |
| GET    | `/api/customers/:id/orders`        | `?product=banana&since=2026-09-13&until=...`   |
| POST   | `/api/customers/:id/orders`        | `{ "product": "apples", "quantity": 2, "unit": "kg" }` |
| DELETE | `/api/orders/:id`                  |                                                |

```bash
curl -X POST localhost:3000/api/customers -H 'content-type: application/json' -d '{"name":"Mr Jones"}'
curl -X POST localhost:3000/api/customers/1/orders -H 'content-type: application/json' -d '{"product":"apples","quantity":2,"unit":"kg"}'
curl 'localhost:3000/api/customers/1/orders?product=apple'
```

## MCP tools

| Tool              | Purpose                                                        |
| ----------------- | -------------------------------------------------------------- |
| `find_customers`  | Resolve "Mr Jones" to a customer id (partial name search)      |
| `add_customer`    | Create a customer                                              |
| `delete_customer` | Delete a customer and their orders                             |
| `list_orders`     | Orders for a customer, filterable by product and date range    |
| `add_order`       | Record an order: product, quantity, unit                       |
| `delete_order`    | Delete one order                                               |

The tool descriptions tell Claude how to chain them, e.g. "How many bananas has
Mary Brown bought in the last month" becomes `find_customers("Mary Brown")` then
`list_orders(customer_id, product="banana", since=<30 days ago>)` and a sum.

## Deploy to Railway

1. Push this repo to GitHub, then in Railway: **New Project → Deploy from GitHub repo**.
   `railway.json` sets the build (`npm ci && npm run build`), start (`npm start`) and health check.
2. Add a **Volume** to the service (service → Settings → Volumes) with mount path `/data`.
3. Add a variable `DB_PATH=/data/app.db`. Railway sets `PORT` for you.
4. Under **Settings → Networking → Generate Domain** to get a public URL.
5. Check `https://<your-app>.up.railway.app/health` returns `{"ok":true}`.

Optional: seed demo data on Railway with `railway run npm run seed` (Railway CLI),
or just add customers through Claude.

## Connect Claude Desktop

**Custom connector (Pro, Max, Team, Enterprise):**
Settings → Connectors → Add custom connector → URL `https://<your-app>.up.railway.app/mcp`.
No auth is configured; anyone with the URL can read and write the data, which is fine for a demo.

**Alternative, any plan (needs Node on your Mac):** add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "customer-orders": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-app>.up.railway.app/mcp"]
    }
  }
}
```

Then try:

- "Can you add an order for Mr Jones of 2kg of apples?"
- "How many bananas has Mary Brown bought in the last month?"
- "Add a new customer called Jane Smith and record that she bought 3 litres of milk."

## Layout

```
src/db.ts       SQLite schema + queries (built-in node:sqlite, no native build)
src/api.ts      Express router for /api
src/mcp.ts      MCP tools, each one an HTTP call to /api
src/server.ts   Wires both into one Express app
scripts/        seed.ts (demo data), smoke-mcp.ts (MCP client test)
```
