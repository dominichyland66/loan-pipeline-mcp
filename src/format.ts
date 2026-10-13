import type { Customer, Order, OrderWithCustomer } from "./db.js";

// Markdown tables for tool results. Claude Desktop renders Markdown, so
// returning a ready-made table means replies arrive formatted. IDs are kept
// so Claude can chain calls (find_customers -> add_order etc.).

const esc = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|");
const day = (iso: string) => iso.slice(0, 10);

const EMOJI: Record<string, string> = {
  banana: "🍌", apple: "🍎", pear: "🍐", orange: "🍊", milk: "🥛", bread: "🍞",
  egg: "🥚", cheese: "🧀", grape: "🍇", strawberry: "🍓", carrot: "🥕", potato: "🥔",
  tomato: "🍅", chicken: "🍗", fish: "🐟", coffee: "☕", tea: "🍵", water: "💧",
};
export function productEmoji(product: string): string {
  const p = product.toLowerCase();
  const key = Object.keys(EMOJI).find((k) => p.includes(k));
  return key ? EMOJI[key] : "📦";
}

export function customersTable(rows: Customer[]): string {
  if (rows.length === 0) return "_No customers found._";
  const lines = ["| ID | Name | Email | Customer since |", "|---:|------|-------|----------------|"];
  for (const c of rows) lines.push(`| ${c.id} | **${esc(c.name)}** | ${esc(c.email ?? "—")} | ${day(c.created_at)} |`);
  return lines.join("\n");
}

export function customerCard(c: Customer): string {
  return customersTable([c]);
}

export function ordersTable(rows: Order[], customer?: Customer): string {
  const title = customer ? `**Orders for ${esc(customer.name)}** (customer #${customer.id})\n\n` : "";
  if (rows.length === 0) return `${title}_No orders found._`;
  const lines = ["| Order | Date | Product | Qty | Unit |", "|------:|------|---------|----:|------|"];
  for (const o of rows) {
    lines.push(`| ${o.id} | ${day(o.created_at)} | ${productEmoji(o.product)} ${esc(o.product)} | ${o.quantity} | ${esc(o.unit)} |`);
  }
  // Totals per product+unit so "how many bananas" is answered at a glance.
  const totals = new Map<string, number>();
  for (const o of rows) {
    const k = `${o.product} (${o.unit})`;
    totals.set(k, (totals.get(k) ?? 0) + o.quantity);
  }
  const summary = [...totals].map(([k, n]) => `${k}: **${n}**`).join(" · ");
  return `${title}${lines.join("\n")}\n\nTotals: ${summary}`;
}

export function orderCard(o: Order): string {
  return ordersTable([o]);
}

export function searchTable(rows: OrderWithCustomer[], filters: Record<string, string | undefined>): string {
  const desc = Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `${k}: ${esc(v)}`).join(", ");
  const title = `**Orders across all customers**${desc ? ` (${desc})` : ""}\n\n`;
  if (rows.length === 0) return `${title}_No matching orders._`;
  const lines = ["| Order | Date | Customer | Product | Qty | Unit |", "|------:|------|----------|---------|----:|------|"];
  for (const o of rows) {
    lines.push(`| ${o.id} | ${day(o.created_at)} | **${esc(o.customer_name)}** (#${o.customer_id}) | ${productEmoji(o.product)} ${esc(o.product)} | ${o.quantity} | ${esc(o.unit)} |`);
  }
  // Who bought it: per-customer totals per product+unit.
  const totals = new Map<string, number>();
  for (const o of rows) {
    const k = `${o.customer_name}: ${o.product} (${o.unit})`;
    totals.set(k, (totals.get(k) ?? 0) + o.quantity);
  }
  const summary = [...totals].map(([k, n]) => `${k} **${n}**`).join(" · ");
  return `${title}${lines.join("\n")}\n\nTotals: ${summary}`;
}
