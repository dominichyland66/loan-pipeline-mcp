// Smoke test: exercises every MCP tool against a running server.
// Usage: npm run smoke            (local)
//        MCP_URL=https://<app>.up.railway.app/mcp npm run smoke
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "http://localhost:3000/mcp";
const client = new Client({ name: "test-client", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

const instructions = client.getInstructions();
console.log("INSTRUCTIONS:", instructions ? `${instructions.split("\n")[0]} …` : "(none)");

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

let failures = 0;
const show = (label: string, r: any, expectError = false) => {
  const bad = Boolean(r.isError) !== expectError;
  if (bad) failures++;
  const body = r.content.map((c: any) => c.text).join("\n");
  console.log(`\n== ${label}${bad ? "  <<< UNEXPECTED" : ""}\n` + (label.includes("all topics") ? body.slice(0, 400) + "\n…" : body) +
    (r.isError ? "\n(isError)" : "") + (r.structuredContent ? `\n[structuredContent kind=${r.structuredContent.kind}]` : ""));
  return r;
};
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
const idIn = (r: any, word: string) => Number(new RegExp(`${word} #(\\d+)`).exec(r.content[0].text)![1]);

// --- Set up a broker and a business customer ---------------------------------
const broker = show("add_broker", await call("add_broker", { name: "Smoke Tester", firm: "Smoke & Co Brokers", email: "smoke@example.com" }));
const brokerId = idIn(broker, "broker");
show("find_brokers smoke", await call("find_brokers", { search: "smoke & co" }));

const cust = show("add_customer (business)", await call("add_customer", { name: "Tess Smoke", email: "tess@smokewidgets.example", company_name: "Smoke Widgets Ltd" }));
const customerId = idIn(cust, "customer");
show("find_customers by company", await call("find_customers", { search: "smoke widgets" }));
show("update_customer email", await call("update_customer", { customer_id: customerId, email: "finance@smokewidgets.example" }));
show("update_customer nothing (error)", await call("update_customer", { customer_id: customerId }), true);

// --- Walk an application through the whole pipeline --------------------------
const app = show("add_application £20k/36m", await call("add_application", { customer_id: customerId, amount: 20000, term_months: 36, purpose: "Stock purchase", broker_id: brokerId, note: "Smoke test" }));
const appId = idIn(app, "application");
show("advance received→funded (error: not allowed)", await call("advance_application", { application_id: appId, status: "funded" }), true);
for (const [status, actor, note] of [
  ["kyc_passed", "KYC service", "Directors verified"],
  ["aml_passed", "AML screening", undefined],
  ["awaiting_underwriter", "Onboarding team", undefined],
  ["approved", "J. Underwriter", "Approved, 1.6x cover"],
  ["offer_issued", "Funding team", undefined],
  ["funded", "Funding team", "Funds released"],
] as const) {
  const r = await call("advance_application", { application_id: appId, status, actor, note });
  if (r.isError) show(`advance → ${status}`, r);
  else console.log(`advance → ${status}: ok`);
}
show("advance funded→withdrawn (error: terminal)", await call("advance_application", { application_id: appId, status: "withdrawn" }), true);
show("get_application (history)", await call("get_application", { application_id: appId }));
show("update_application purpose + term", await call("update_application", { application_id: appId, purpose: "Stock purchase (Q4)", term_months: 48 }));
show("update_application nothing (error)", await call("update_application", { application_id: appId }), true);
show("list_applications for customer", await call("list_applications", { customer_id: customerId }));

// --- A personal customer cannot have a business application -----------------
const person = show("add_customer (personal)", await call("add_customer", { name: "Pat Smoke" }));
const personId = idIn(person, "customer");
show("add_application business for personal customer (error)", await call("add_application", { customer_id: personId, amount: 5000, term_months: 12, purpose: "Bike", type: "business" }), true);
const personal = show("add_application personal (direct)", await call("add_application", { customer_id: personId, amount: 5000, term_months: 12, purpose: "Bike" }));
const personalId = idIn(personal, "application");
show("advance → withdrawn", await call("advance_application", { application_id: personalId, status: "withdrawn", note: "Changed mind" }));

// --- Cross-customer views ----------------------------------------------------
const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
show("search_applications awaiting_underwriter", await call("search_applications", { status: "awaiting_underwriter" }));
show("search_applications open business", await call("search_applications", { open: true, type: "business" }));
show("search_applications broker northgate last 30 days", await call("search_applications", { broker: "northgate", since }));
show("search_applications customer smoke", await call("search_applications", { customer: "smoke" }));
show("pipeline_summary", await call("pipeline_summary"));
show("get_application missing (error)", await call("get_application", { application_id: 999999 }), true);
show("list_applications missing customer (error)", await call("list_applications", { customer_id: 999999 }), true);

// --- Self-description ----------------------------------------------------------
const aboutAll = show("explain_system (all topics)", await call("explain_system"));
const aboutText: string = aboutAll.content[0].text;
console.log(`(about document: ${aboutText.length} chars, ${(aboutText.match(/^## /gm) ?? []).length} sections)`);
show("explain_system pipeline", await call("explain_system", { topic: "pipeline" }));

// --- Clean up ---------------------------------------------------------------
show("delete_application (personal)", await call("delete_application", { application_id: personalId }));
show("delete_customer (personal)", await call("delete_customer", { customer_id: personId }));
show("delete_customer (business, cascades)", await call("delete_customer", { customer_id: customerId }));
show("delete_broker", await call("delete_broker", { broker_id: brokerId }));
show("delete_broker again (error)", await call("delete_broker", { broker_id: brokerId }), true);
await client.close();
console.log(failures ? `\n${failures} UNEXPECTED RESULT(S)` : "\nAll tool calls behaved as expected.");
process.exit(failures ? 1 : 0);
