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
npm run dev          # http://localhost:3000 (builds the widget first)
npm run seed         # optional demo data (Mary Brown, Peter Jones, Sam Patel)
npm run smoke        # drives every MCP tool through a real MCP client
```

Data lives in `./data/app.db` (override with `DB_PATH`). On startup, an empty
database is seeded with demo data (set `SEED_DEMO_DATA=false` to turn that off).

## REST API

| Method | Path                               | Body / query                                   |
| ------ | ---------------------------------- | ---------------------------------------------- |
| GET    | `/api/customers?search=jones`      | optional partial, case-insensitive name search |
| POST   | `/api/customers`                   | `{ "name": "Mary Brown", "email": "..." }`     |
| GET    | `/api/customers/:id`               |                                                |
| PATCH  | `/api/customers/:id`               | `{ "name": "...", "email": "..." }` any subset; `"email": null` clears |
| DELETE | `/api/customers/:id`               | also deletes that customer's orders            |
| GET    | `/api/customers/:id/orders`        | `?product=banana&since=2026-09-13&until=...`   |
| POST   | `/api/customers/:id/orders`        | `{ "product": "apples", "quantity": 2, "unit": "kg" }` |
| GET    | `/api/orders`                      | `?product=cheese&customer=brown&since=...&until=...` across all customers |
| GET    | `/api/orders/:id`                  |                                                |
| PATCH  | `/api/orders/:id`                  | `{ "product": "...", "quantity": 3, "unit": "..." }` any subset |
| DELETE | `/api/orders/:id`                  |                                                |

```bash
curl -X POST localhost:3000/api/customers -H 'content-type: application/json' -d '{"name":"Mr Jones"}'
curl -X POST localhost:3000/api/customers/1/orders -H 'content-type: application/json' -d '{"product":"apples","quantity":2,"unit":"kg"}'
curl 'localhost:3000/api/customers/1/orders?product=apple'
```

## MCP tools

Every tool returns a ready-made **Markdown table** (with per-product totals for
orders), and the server sends Claude **instructions** on how to chain the tools
and to show those tables as-is. `find_customers`, `list_orders` and `search_orders` additionally
carry an **MCP App widget**: hosts that support MCP Apps (claude.ai and Claude
Desktop) render a styled, colourful table inside the chat; other hosts just
show the Markdown.

| Tool              | Purpose                                                        |
| ----------------- | -------------------------------------------------------------- |
| `find_customers`  | Resolve "Mr Jones" to a customer id (partial name search)      |
| `add_customer`    | Create a customer                                              |
| `update_customer` | Change a customer's name and/or email                          |
| `delete_customer` | Delete a customer and their orders                             |
| `list_orders`     | Orders for a customer, filterable by product and date range    |
| `search_orders`   | Orders across all customers, filterable by product, customer, dates |
| `add_order`       | Record an order: product, quantity, unit                       |
| `update_order`    | Change an order's product, quantity and/or unit                |
| `delete_order`    | Delete one order                                               |

The tool descriptions tell Claude how to chain them, e.g. "How many bananas has
Mary Brown bought in the last month" becomes `find_customers("Mary Brown")` then
`list_orders(customer_id, product="banana", since=<30 days ago>)` and a sum.

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
- "Update Mary Brown's email to mary@newmail.com."
- "Mr Jones' apple order should have been 3kg, not 2kg. Please fix it."
- "Who bought cheese?"
- "What orders did Mary Brown make?"

## Layout

```
src/db.ts       SQLite schema + queries (built-in node:sqlite, no native build)
src/api.ts      Express router for /api
src/mcp.ts      MCP tools, each one an HTTP call to /api; server instructions; widget resource
src/format.ts   Markdown table rendering for tool results
src/widget/     MCP App widget (HTML + TS), bundled by scripts/build-widget.mjs into dist/widget.html
src/server.ts   Wires both into one Express app
src/seed.ts     demo data, applied automatically to an empty database
scripts/        seed.ts (manual seed), smoke-mcp.ts (MCP client test), build-widget.mjs
```
