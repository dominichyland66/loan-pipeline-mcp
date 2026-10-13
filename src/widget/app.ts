// Runs inside the chat iframe. Receives the tool result from the host via the
// MCP Apps SDK and renders a styled table. Bundled by scripts/build-widget.mjs.
import { App, applyDocumentTheme, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";

interface Customer { id: number; name: string; email: string | null; created_at: string }
interface Order { id: number; customer_id: number; product: string; quantity: number; unit: string; created_at: string }
type Payload =
  | { kind: "customers"; customers: Customer[] }
  | { kind: "orders"; customer: Customer; filters: { product?: string; since?: string; until?: string }; orders: Order[] };

const EMOJI: Record<string, string> = {
  banana: "🍌", apple: "🍎", pear: "🍐", orange: "🍊", milk: "🥛", bread: "🍞",
  egg: "🥚", cheese: "🧀", grape: "🍇", strawberry: "🍓", carrot: "🥕", potato: "🥔",
  tomato: "🍅", chicken: "🍗", fish: "🐟", coffee: "☕", tea: "🍵", water: "💧",
};
const emoji = (p: string) => { const k = Object.keys(EMOJI).find((e) => p.toLowerCase().includes(e)); return k ? EMOJI[k] : "📦"; };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

const root = document.getElementById("root")!;

function render(data: Payload | undefined, fallbackText?: string) {
  if (!data) {
    root.innerHTML = `<div class="empty">${esc(fallbackText ?? "No data")}</div>`;
    return;
  }
  if (data.kind === "customers") {
    const rows = data.customers.map((c) => `
      <tr><td class="id">#${c.id}</td><td><strong>${esc(c.name)}</strong></td>
      <td>${c.email ? esc(c.email) : '<span style="color:var(--muted)">—</span>'}</td><td>${day(c.created_at)}</td></tr>`).join("");
    root.innerHTML = `
      <div class="head"><h1>👥 Customers</h1><span class="sub">${data.customers.length} found</span></div>
      ${data.customers.length ? `<div class="scroll"><table><thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Customer since</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">No customers match.</div>`}`;
    return;
  }
  const totals = new Map<string, number>();
  for (const o of data.orders) totals.set(`${o.product} (${o.unit})`, (totals.get(`${o.product} (${o.unit})`) ?? 0) + o.quantity);
  const chips = Object.entries(data.filters).map(([k, v]) => `<span>${esc(k)}: ${esc(v)}</span>`).join("");
  const rows = data.orders.map((o) => `
    <tr><td class="id">#${o.id}</td><td>${day(o.created_at)}</td>
    <td><span class="emoji">${emoji(o.product)}</span>${esc(o.product)}</td>
    <td class="num">${o.quantity}</td><td><span class="chip">${esc(o.unit)}</span></td></tr>`).join("");
  root.innerHTML = `
    <div class="head"><div><h1>🧾 Orders for ${esc(data.customer.name)}</h1><span class="sub">customer #${data.customer.id} · ${data.orders.length} order${data.orders.length === 1 ? "" : "s"}</span></div><div class="filters">${chips}</div></div>
    ${data.orders.length
      ? `<div class="scroll"><table><thead><tr><th>Order</th><th>Date</th><th>Product</th><th class="num">Qty</th><th>Unit</th></tr></thead><tbody>${rows}</tbody></table></div>
         <div class="totals">${[...totals].map(([k, n]) => `<span>${esc(k)}: ${n}</span>`).join("")}</div>`
      : `<div class="empty">No orders match.</div>`}`;
}

function applyContext(ctx: McpUiHostContext | undefined) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

const app = new App({ name: "Customer orders table", version: "1.0.0" });
app.ontoolresult = (result) => {
  const textPart = result.content?.find((c) => c.type === "text") as { text?: string } | undefined;
  render(result.structuredContent as Payload | undefined, result.isError ? textPart?.text : undefined);
};
app.onhostcontextchanged = applyContext;
app.onerror = console.error;
app.connect().then(() => applyContext(app.getHostContext()));
