// Smoke test: exercises every MCP tool against a running server.
// Usage: npm run smoke            (local)
//        MCP_URL=https://<app>.up.railway.app/mcp npm run smoke

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "test-client", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${process.env.MCP_URL ?? "http://localhost:3000/mcp"}`)));

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const show = (label: string, r: any) => console.log(`\n== ${label}\n` + r.content.map((c: any) => c.text).join("\n") + (r.isError ? "\n(isError)" : ""));

show("add_customer", await client.callTool({ name: "add_customer", arguments: { name: "Mr Jones" } }));
const found: any = await client.callTool({ name: "find_customers", arguments: { search: "jones" } });
show("find_customers jones", found);
const jones = JSON.parse(found.content[0].text)[0];
show("update_customer rename + email", await client.callTool({ name: "update_customer", arguments: { customer_id: jones.id, name: "Mr P Jones", email: "pj@example.com" } }));
show("update_customer clear email", await client.callTool({ name: "update_customer", arguments: { customer_id: jones.id, email: "" } }));
show("update_customer nothing (error)", await client.callTool({ name: "update_customer", arguments: { customer_id: jones.id } }));
const added: any = await client.callTool({ name: "add_order", arguments: { customer_id: jones.id, product: "apples", quantity: 2, unit: "kg" } });
show("add_order 2kg apples", added);
const orderId = JSON.parse(added.content[0].text).id;
show("update_order quantity 3", await client.callTool({ name: "update_order", arguments: { order_id: orderId, quantity: 3 } }));
show("update_order product pears, unit each", await client.callTool({ name: "update_order", arguments: { order_id: orderId, product: "pears", unit: "each" } }));
show("update_order nothing (error)", await client.callTool({ name: "update_order", arguments: { order_id: orderId } }));
show("update_order missing (error)", await client.callTool({ name: "update_order", arguments: { order_id: 999999, quantity: 1 } }));
// Mary Brown may not exist on a fresh database; create her if needed.
let mary: any = await client.callTool({ name: "find_customers", arguments: { search: "mary brown" } });
let maryList = JSON.parse(mary.content[0].text);
if (maryList.length === 0) {
  show("add_customer Mary Brown (missing)", await client.callTool({ name: "add_customer", arguments: { name: "Mary Brown" } }));
  mary = await client.callTool({ name: "find_customers", arguments: { search: "mary brown" } });
  maryList = JSON.parse(mary.content[0].text);
}
const maryId = maryList[0].id;
show("list_orders mary bananas last month", await client.callTool({ name: "list_orders", arguments: { customer_id: maryId, product: "banana", since: "2026-09-13" } }));
show("delete_customer (missing)", await client.callTool({ name: "delete_customer", arguments: { customer_id: 999 } }));
show("delete_customer jones", await client.callTool({ name: "delete_customer", arguments: { customer_id: jones.id } }));
await client.close();
