import type { Broker, Customer, ApplicationRow, ApplicationEvent, StatusCount } from "./db.js";
import { type Status, LABELS, TRANSITIONS, statusWithIcon, isOpen } from "./pipeline.js";

// Markdown tables for tool results. Claude Desktop renders Markdown, so
// returning a ready-made table means replies arrive formatted. IDs are kept
// so Claude can chain calls (find_customers -> add_application etc.).

const esc = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|");
const day = (iso: string) => iso.slice(0, 10);
const dash = (v: string | null | undefined) => (v ? esc(v) : "—");

export const money = (n: number) =>
  "£" + n.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const term = (months: number) => `${months} mo`;
const loanType = (t: string) => (t === "business" ? "Business" : "Personal");
const borrower = (name: string, company: string | null) => (company ? `**${esc(company)}** (${esc(name)})` : `**${esc(name)}**`);
const brokerCell = (name: string | null, firm: string | null) => (name ? `${esc(name)}, ${esc(firm)}` : "_Direct_");

const filterDesc = (filters: Record<string, string | boolean | undefined>) =>
  Object.entries(filters)
    .filter(([, v]) => v !== undefined && v !== "" && v !== false)
    .map(([k, v]) => (k === "status" ? `status: ${LABELS[v as Status] ?? v}` : v === true ? k : `${k}: ${esc(v)}`))
    .join(", ");

// --- Brokers / customers -----------------------------------------------------

export function brokersTable(rows: Broker[]): string {
  if (rows.length === 0) return "_No brokers found._";
  const lines = ["| ID | Broker | Firm | Email |", "|---:|--------|------|-------|"];
  for (const b of rows) lines.push(`| ${b.id} | **${esc(b.name)}** | ${esc(b.firm)} | ${dash(b.email)} |`);
  return lines.join("\n");
}
export const brokerCard = (b: Broker) => brokersTable([b]);

export function customersTable(rows: Customer[]): string {
  if (rows.length === 0) return "_No customers found._";
  const lines = ["| ID | Name | Company | Type | Email | Since |", "|---:|------|---------|------|-------|-------|"];
  for (const c of rows) {
    lines.push(`| ${c.id} | **${esc(c.name)}** | ${dash(c.company_name)} | ${c.company_name ? "Business" : "Personal"} | ${dash(c.email)} | ${day(c.created_at)} |`);
  }
  return lines.join("\n");
}
export const customerCard = (c: Customer) => customersTable([c]);

// --- Applications ------------------------------------------------------------

function totalsLine(rows: ApplicationRow[]): string {
  const total = rows.reduce((n, a) => n + a.amount, 0);
  const open = rows.filter((a) => isOpen(a.status));
  const byStatus = new Map<Status, number>();
  for (const a of rows) byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
  const breakdown = [...byStatus].map(([s, n]) => `${LABELS[s]} ${n}`).join(" · ");
  return `Totals: **${rows.length}** application${rows.length === 1 ? "" : "s"}, **${money(total)}** requested` +
    ` (${open.length} open, ${money(open.reduce((n, a) => n + a.amount, 0))}) · ${breakdown}`;
}

/** Applications for one customer (no Customer column). */
export function applicationsTable(rows: ApplicationRow[], customer: Customer, filters: Record<string, string | undefined> = {}): string {
  const desc = filterDesc(filters);
  const title = `**Applications for ${esc(customer.company_name ?? customer.name)}** (customer #${customer.id}${desc ? `, ${desc}` : ""})\n\n`;
  if (rows.length === 0) return `${title}_No applications found._`;
  const lines = ["| App | Received | Type | Amount | Term | Purpose | Broker | Status |", "|----:|----------|------|-------:|-----:|---------|--------|--------|"];
  for (const a of rows) {
    lines.push(`| ${a.id} | ${day(a.created_at)} | ${loanType(a.type)} | ${money(a.amount)} | ${term(a.term_months)} | ${esc(a.purpose)} | ${brokerCell(a.broker_name, a.broker_firm)} | ${statusWithIcon(a.status)} |`);
  }
  return `${title}${lines.join("\n")}\n\n${totalsLine(rows)}`;
}

/** Applications across customers (with a Customer column). */
export function searchTable(rows: ApplicationRow[], filters: Record<string, string | boolean | undefined>): string {
  const desc = filterDesc(filters);
  const title = `**Applications across all customers**${desc ? ` (${desc})` : ""}\n\n`;
  if (rows.length === 0) return `${title}_No matching applications._`;
  const lines = ["| App | Received | Customer | Type | Amount | Term | Purpose | Broker | Status |", "|----:|----------|----------|------|-------:|-----:|---------|--------|--------|"];
  for (const a of rows) {
    lines.push(`| ${a.id} | ${day(a.created_at)} | ${borrower(a.customer_name, a.company_name)} (#${a.customer_id}) | ${loanType(a.type)} | ${money(a.amount)} | ${term(a.term_months)} | ${esc(a.purpose)} | ${brokerCell(a.broker_name, a.broker_firm)} | ${statusWithIcon(a.status)} |`);
  }
  // Per-broker totals so "which broker sent the most business" is answered at a glance.
  const byBroker = new Map<string, { n: number; amount: number }>();
  for (const a of rows) {
    const k = a.broker_firm ?? "Direct";
    const cur = byBroker.get(k) ?? { n: 0, amount: 0 };
    byBroker.set(k, { n: cur.n + 1, amount: cur.amount + a.amount });
  }
  const brokersLine = [...byBroker].map(([k, v]) => `${esc(k)} ${v.n} (${money(v.amount)})`).join(" · ");
  return `${title}${lines.join("\n")}\n\n${totalsLine(rows)}\n\nBy broker: ${brokersLine}`;
}

/** One application in full: details plus its status history. */
export function applicationCard(a: ApplicationRow, events: ApplicationEvent[]): string {
  const next = TRANSITIONS[a.status];
  const details = [
    `**Application #${a.id}** · ${statusWithIcon(a.status)}`,
    "",
    "| Field | Value |",
    "|-------|-------|",
    `| Customer | ${borrower(a.customer_name, a.company_name)} (customer #${a.customer_id}) |`,
    `| Loan | ${loanType(a.type)}, **${money(a.amount)}** over ${term(a.term_months)} |`,
    `| Purpose | ${esc(a.purpose)} |`,
    `| Broker | ${brokerCell(a.broker_name, a.broker_firm)}${a.broker_id ? ` (broker #${a.broker_id})` : ""} |`,
    `| Received | ${day(a.created_at)} |`,
    `| Last update | ${day(a.updated_at)} |`,
    `| Next possible | ${next.length ? next.map((s) => LABELS[s]).join(", ") : "none, this is a final status"} |`,
  ];
  const history = ["", "**History**", "", "| Date | Status | By | Note |", "|------|--------|----|------|"];
  for (const e of events) history.push(`| ${day(e.created_at)} | ${statusWithIcon(e.to_status)} | ${dash(e.actor)} | ${dash(e.note)} |`);
  if (events.length === 0) history.push("| — | — | — | _No events recorded_ |");
  return [...details, ...history].join("\n");
}

/** Pipeline overview: how many applications sit at each stage. */
export function pipelineTable(summary: StatusCount[]): string {
  const lines = ["| Stage | Applications | Total requested |", "|-------|-------------:|----------------:|"];
  for (const s of summary) lines.push(`| ${statusWithIcon(s.status)} | ${s.count} | ${money(s.total_amount)} |`);
  const open = summary.filter((s) => isOpen(s.status));
  const closed = summary.filter((s) => !isOpen(s.status));
  const sum = (rows: StatusCount[], k: "count" | "total_amount") => rows.reduce((n, r) => n + r[k], 0);
  return `**Pipeline summary**\n\n${lines.join("\n")}\n\n` +
    `Open: **${sum(open, "count")}** applications, **${money(sum(open, "total_amount"))}** · ` +
    `Closed: ${sum(closed, "count")} applications, ${money(sum(closed, "total_amount"))}`;
}
