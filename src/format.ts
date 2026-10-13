import type { Broker, Customer, CustomerLocation, ApplicationRow, ApplicationEvent, StatusCount } from "./db.js";
import type { AccessLogRow, UsageSummary } from "./accesslog.js";
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
  const lines = ["| ID | Name | Company | Type | Email | Postcode | Area | Since |", "|---:|------|---------|------|-------|----------|------|-------|"];
  for (const c of rows) {
    lines.push(`| ${c.id} | **${esc(c.name)}** | ${dash(c.company_name)} | ${c.company_name ? "Business" : "Personal"} | ${dash(c.email)} | ${dash(c.postcode)} | ${dash(c.area)} | ${day(c.created_at)} |`);
  }
  return lines.join("\n");
}
export const customerCard = (c: Customer) => customersTable([c]);

/** Customers with coordinates and application totals, for a map. */
export function locationsTable(rows: CustomerLocation[], filters: Record<string, string | boolean | undefined> = {}): string {
  const desc = filterDesc(filters);
  const title = `**Customer locations**${desc ? ` (${desc})` : ""}\n\n`;
  if (rows.length === 0) return title + "_No customers found._";
  const lines = [
    "| ID | Customer | Type | Postcode | Area | Lat | Lng | Applications | Requested | Open |",
    "|---:|----------|------|----------|------|----:|----:|-------------:|----------:|-----:|",
  ];
  for (const c of rows) {
    lines.push(`| ${c.id} | ${borrower(c.name, c.company_name)} | ${c.company_name ? "Business" : "Personal"} | ${dash(c.postcode)} | ${dash(c.area)} | ` +
      `${c.latitude === null ? "—" : c.latitude.toFixed(5)} | ${c.longitude === null ? "—" : c.longitude.toFixed(5)} | ${c.applications} | ${money(c.total_amount)} | ${money(c.open_amount)} |`);
  }
  const located = rows.filter((c) => c.latitude !== null);
  const missing = rows.filter((c) => c.latitude === null);
  const total = rows.reduce((n, c) => n + c.total_amount, 0);
  const openTotal = rows.reduce((n, c) => n + c.open_amount, 0);
  lines.push("", `Totals: **${rows.length}** customer${rows.length === 1 ? "" : "s"}, ${located.length} with coordinates, **${money(total)}** requested in total (${money(openTotal)} open)` +
    (missing.length ? ` · no postcode: ${missing.map((c) => `${c.name} (#${c.id})`).join(", ")}` : ""));
  return lines.join("\n");
}

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

// --- Access logs ---------------------------------------------------------------

const ms = (n: number) => `${Math.round(n * 10) / 10} ms`;
const time = (iso: string) => iso.slice(11, 19);

export function requestsTable(rows: AccessLogRow[], filters: Record<string, string | number | undefined>): string {
  const desc = Object.entries(filters).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}: ${esc(v)}`).join(", ");
  const title = `**Recent requests** (newest first${desc ? `, ${desc}` : ""})\n\n`;
  if (rows.length === 0) return `${title}_No requests logged._`;
  const lines = ["| Time (UTC) | Source | Request | Status | Time | DB queries | DB time | Detail |", "|------------|--------|---------|-------:|-----:|-----------:|--------:|--------|"];
  for (const r of rows) {
    lines.push(`| ${r.ts.slice(0, 10)} ${time(r.ts)} | ${r.source} | ${r.method} ${esc(r.path)} | ${r.status} | ${ms(r.duration_ms)} | ${r.db_queries} | ${ms(r.db_ms)} | ${dash(r.detail)} |`);
  }
  const errors = rows.filter((r) => r.status >= 400).length;
  const dbq = rows.reduce((n, r) => n + r.db_queries, 0);
  return `${title}${lines.join("\n")}\n\nTotals: **${rows.length}** requests shown, ${errors} errors, ${dbq} database queries. Sources: rest = external /api calls, tool = /api calls made by MCP tools, mcp = calls from Claude to /mcp.`;
}

export function usageSummary(s: UsageSummary): string {
  const out: string[] = [];
  const windowDesc = s.window.since || s.window.until ? `${s.window.since ?? "start"} → ${s.window.until ?? "now"}` : "all logged requests";
  out.push(`**API usage summary** (${windowDesc}; logged ${s.window.first ? `${s.window.first.slice(0, 16)}Z to ${s.window.last!.slice(0, 16)}Z` : "nothing yet"})`);
  out.push("");
  out.push(`Requests: **${s.totals.requests}** (${s.totals.errors} errors) · avg ${ms(s.totals.avg_ms)}, max ${ms(s.totals.max_ms)} · database: **${s.totals.db_queries}** queries, ${ms(s.totals.db_ms)} in SQLite. ` +
    `Process up ${Math.round(s.process.uptime_s / 60)} min since ${s.process.started_at.slice(0, 16)}Z; ${s.process.db_queries_total} queries in total including startup and seeding.`);
  if (s.totals.requests === 0) return out.join("\n");

  out.push("", "**By source**", "", "| Source | Requests | Errors | Avg | Max | DB queries | DB time |", "|--------|---------:|-------:|----:|----:|-----------:|--------:|");
  for (const r of s.by_source) out.push(`| ${r.source} | ${r.requests} | ${r.errors} | ${ms(r.avg_ms)} | ${ms(r.max_ms)} | ${r.db_queries} | ${ms(r.db_ms)} |`);
  out.push("", "rest = external callers of /api · tool = /api called by the MCP tools · mcp = Claude talking to /mcp (each tool call appears once as mcp and once as tool).");

  if (s.routes.length) {
    out.push("", "**Busiest API routes**", "", "| Route | Requests | Errors | Avg | Max | DB queries (avg/req) |", "|-------|---------:|-------:|----:|----:|---------------------:|");
    for (const r of s.routes.slice(0, 15)) out.push(`| ${r.method} ${esc(r.route)} | ${r.requests} | ${r.errors} | ${ms(r.avg_ms)} | ${ms(r.max_ms)} | ${r.db_queries} (${r.avg_db_queries}) |`);
  }
  if (s.tools.length) {
    out.push("", "**MCP tool calls**", "", "| Tool | Calls | Errors | Avg | Max |", "|------|------:|-------:|----:|----:|");
    for (const t of s.tools) out.push(`| ${t.tool} | ${t.calls} | ${t.errors} | ${ms(t.avg_ms)} | ${ms(t.max_ms)} |`);
    out.push("", "Other MCP traffic: " + s.mcp_methods.filter((m) => m.mcp_method !== "tools/call").map((m) => `${m.mcp_method} ${m.calls}`).join(" · "));
  }
  if (s.database.by_table.length) {
    out.push("", "**Database activity**", "", "| Table | Statement | Queries | Total | Avg |", "|-------|-----------|--------:|------:|----:|");
    for (const t of s.database.by_table.slice(0, 15)) out.push(`| ${t.table} | ${t.kind} | ${t.queries} | ${ms(t.total_ms)} | ${t.avg_ms} ms |`);
    out.push("", "By statement: " + s.database.by_kind.map((k) => `${k.kind} ${k.queries} (${ms(k.total_ms)})`).join(" · "));
  }
  if (s.per_hour.length) {
    out.push("", "**Per hour (UTC)**", "", "| Hour | Requests | rest | tool | mcp | DB queries | Avg |", "|------|---------:|-----:|-----:|----:|-----------:|----:|");
    for (const h of s.per_hour.slice(-24)) out.push(`| ${h.hour.slice(0, 13)} | ${h.requests} | ${h.rest} | ${h.tool} | ${h.mcp} | ${h.db_queries} | ${ms(h.avg_ms)} |`);
  }
  if (s.slowest.length) {
    out.push("", "**Slowest requests**", "", "| Time (UTC) | Request | Status | Time | DB queries | Detail |", "|------------|---------|-------:|-----:|-----------:|--------|");
    for (const r of s.slowest) out.push(`| ${r.ts.slice(0, 16)} | ${r.method} ${esc(r.path)} | ${r.status} | ${ms(r.duration_ms)} | ${r.db_queries} | ${dash(r.detail)} |`);
  }
  return out.join("\n");
}
