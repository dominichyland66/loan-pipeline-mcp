import type { Request, Response, NextFunction } from "express";
import { db, rawPrepare } from "./db.js";
import { requestContext, processTotals, type RequestMetrics } from "./metrics.js";

// Access log: one row per HTTP request handled by this process (REST, MCP and
// the loopback calls the MCP tools make), plus one row per SQL statement that
// request caused. Lives in the same SQLite file as the business data, so it
// is ephemeral on Railway like everything else, and is pruned to the most
// recent MAX_ROWS requests.

const MAX_ROWS = 20_000;

rawPrepare(`
  CREATE TABLE IF NOT EXISTS access_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    source      TEXT NOT NULL,          -- 'rest' (external /api), 'tool' (/api called by an MCP tool), 'mcp' (/mcp), 'other'
    method      TEXT NOT NULL,
    path        TEXT NOT NULL,          -- actual path, e.g. /api/customers/5
    route       TEXT,                   -- matched pattern, e.g. /api/customers/:id (NULL for 404s)
    status      INTEGER NOT NULL,
    duration_ms REAL NOT NULL,
    detail      TEXT,                   -- MCP: 'tools/call search_applications'; tool: the tool name
    db_queries  INTEGER NOT NULL DEFAULT 0,
    db_ms       REAL NOT NULL DEFAULT 0,
    ip          TEXT
  )`).run();
rawPrepare(`
  CREATE TABLE IF NOT EXISTS query_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id  INTEGER NOT NULL REFERENCES access_log(id) ON DELETE CASCADE,
    ts          TEXT NOT NULL,
    kind        TEXT NOT NULL,          -- SELECT / INSERT / UPDATE / DELETE / PRAGMA / OTHER
    table_name  TEXT,
    duration_ms REAL NOT NULL
  )`).run();
rawPrepare("CREATE INDEX IF NOT EXISTS idx_access_log_ts ON access_log(ts)").run();
rawPrepare("CREATE INDEX IF NOT EXISTS idx_query_log_request ON query_log(request_id)").run();

const insertRequest = rawPrepare(
  "INSERT INTO access_log (ts, source, method, path, route, status, duration_ms, detail, db_queries, db_ms, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
const insertQuery = rawPrepare("INSERT INTO query_log (request_id, ts, kind, table_name, duration_ms) VALUES (?, ?, ?, ?, ?)");
const prune = rawPrepare("DELETE FROM access_log WHERE id <= (SELECT MAX(id) FROM access_log) - ?");

export interface AccessLogRow {
  id: number; ts: string; source: string; method: string; path: string; route: string | null;
  status: number; duration_ms: number; detail: string | null; db_queries: number; db_ms: number; ip: string | null;
}

/** Requests that are not logged: the health check and reading the log itself. */
const IGNORED = (path: string) => path === "/health" || path.startsWith("/api/logs");

function mcpDetail(body: unknown): string | null {
  if (Array.isArray(body)) return `batch(${body.length})`;
  const b = body as { method?: string; params?: { name?: string } } | undefined;
  if (!b?.method) return null;
  return b.params?.name ? `${b.method} ${b.params.name}` : b.method;
}

/** Express middleware: times the request, collects its DB activity and writes both to the log on finish. */
export function accessLogger(req: Request, res: Response, next: NextFunction) {
  if (IGNORED(req.path)) return next();
  const started = performance.now();
  const ts = new Date().toISOString();
  const ctx: RequestMetrics = { queries: [] };

  res.on("finish", () => {
    const duration = performance.now() - started;
    // req.path is rewritten while a mounted router handles the request, so use originalUrl.
    const path = req.originalUrl.split("?")[0];
    const route = req.route ? `${req.baseUrl}${(req.route as { path: string }).path}` : null;
    const toolHeader = req.header("x-mcp-tool");
    const source = path.startsWith("/mcp") ? "mcp" : path.startsWith("/api") ? (toolHeader ? "tool" : "rest") : "other";
    const detail = source === "mcp" ? (mcpDetail(req.body) ?? (req.method === "POST" ? null : `${req.method} (not supported, stateless)`)) : toolHeader ?? null;
    const dbMs = ctx.queries.reduce((n, q) => n + q.ms, 0);
    try {
      const info = insertRequest.run(ts, source, req.method, path, route, res.statusCode, duration, detail, ctx.queries.length, dbMs, req.ip ?? null);
      const id = Number(info.lastInsertRowid);
      for (const q of ctx.queries) insertQuery.run(id, ts, q.kind, q.table, q.ms);
      if (id % 500 === 0) prune.run(MAX_ROWS);
    } catch (err) {
      console.error("access log write failed:", err);
    }
  });

  requestContext.run(ctx, next);
}

// --- Reading the log ------------------------------------------------------------

export interface LogQuery {
  since?: string; until?: string; source?: string; route?: string; detail?: string; status_min?: number; limit?: number;
}

function where(opts: { since?: string; until?: string }, alias = "") {
  const w: string[] = [];
  const p: (string | number)[] = [];
  if (opts.since) { w.push(`${alias}ts >= ?`); p.push(opts.since); }
  if (opts.until) { w.push(`${alias}ts <= ?`); p.push(opts.until); }
  return { w, p };
}

export interface UsageSummary {
  window: { since: string | null; until: string | null; first: string | null; last: string | null };
  process: { started_at: string; uptime_s: number; db_queries_total: number; db_ms_total: number };
  totals: { requests: number; errors: number; avg_ms: number; max_ms: number; db_queries: number; db_ms: number };
  by_source: { source: string; requests: number; errors: number; avg_ms: number; max_ms: number; db_queries: number; db_ms: number }[];
  routes: { method: string; route: string; requests: number; errors: number; avg_ms: number; max_ms: number; db_queries: number; avg_db_queries: number; db_ms: number }[];
  tools: { tool: string; calls: number; errors: number; avg_ms: number; max_ms: number }[];
  mcp_methods: { mcp_method: string; calls: number }[];
  per_hour: { hour: string; requests: number; rest: number; tool: number; mcp: number; db_queries: number; avg_ms: number }[];
  database: { by_table: { table: string; kind: string; queries: number; total_ms: number; avg_ms: number }[]; by_kind: { kind: string; queries: number; total_ms: number }[] };
  slowest: AccessLogRow[];
}

export const logs = {
  recent(opts: LogQuery = {}): AccessLogRow[] {
    const { w, p } = where(opts);
    if (opts.source) { w.push("source = ?"); p.push(opts.source); }
    if (opts.route) { w.push("(route LIKE ? OR path LIKE ?)"); p.push(`%${opts.route}%`, `%${opts.route}%`); }
    if (opts.detail) { w.push("detail LIKE ?"); p.push(`%${opts.detail}%`); }
    if (opts.status_min) { w.push("status >= ?"); p.push(opts.status_min); }
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    return db.prepare(`SELECT * FROM access_log ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY id DESC LIMIT ${limit}`).all(...p) as unknown as AccessLogRow[];
  },

  summary(opts: { since?: string; until?: string } = {}): UsageSummary {
    const { w, p } = where(opts);
    const W = w.length ? "WHERE " + w.join(" AND ") : "";
    const agg = "COUNT(*) AS requests, SUM(status >= 400) AS errors, ROUND(AVG(duration_ms), 1) AS avg_ms, ROUND(MAX(duration_ms), 1) AS max_ms, SUM(db_queries) AS db_queries, ROUND(SUM(db_ms), 1) AS db_ms";
    const q = <T>(sql: string, params: (string | number)[] = p) => db.prepare(sql).all(...params) as unknown as T[];
    const one = <T>(sql: string, params: (string | number)[] = p) => db.prepare(sql).get(...params) as unknown as T;

    const totals = one<UsageSummary["totals"]>(`SELECT ${agg} FROM access_log ${W}`);
    const bounds = one<{ first: string | null; last: string | null }>(`SELECT MIN(ts) AS first, MAX(ts) AS last FROM access_log ${W}`);
    const by_source = q<UsageSummary["by_source"][number]>(`SELECT source, ${agg} FROM access_log ${W} GROUP BY source ORDER BY requests DESC`);
    const routes = q<UsageSummary["routes"][number]>(
      `SELECT method, COALESCE(route, path) AS route, ${agg}, ROUND(AVG(db_queries), 1) AS avg_db_queries FROM access_log ${W ? W + " AND" : "WHERE"} path NOT LIKE '/mcp%' GROUP BY method, COALESCE(route, path) ORDER BY requests DESC`,
    );
    const tools = q<UsageSummary["tools"][number]>(
      `SELECT substr(detail, 12) AS tool, COUNT(*) AS calls, SUM(status >= 400) AS errors, ROUND(AVG(duration_ms), 1) AS avg_ms, ROUND(MAX(duration_ms), 1) AS max_ms FROM access_log ${W ? W + " AND" : "WHERE"} source = 'mcp' AND detail LIKE 'tools/call %' GROUP BY tool ORDER BY calls DESC`,
    );
    const mcp_methods = q<UsageSummary["mcp_methods"][number]>(
      `SELECT CASE WHEN detail LIKE 'tools/call %' THEN 'tools/call' ELSE COALESCE(detail, '(unknown)') END AS mcp_method, COUNT(*) AS calls FROM access_log ${W ? W + " AND" : "WHERE"} source = 'mcp' GROUP BY mcp_method ORDER BY calls DESC`,
    );
    const per_hour = q<UsageSummary["per_hour"][number]>(
      `SELECT substr(ts, 1, 13) || ':00Z' AS hour, COUNT(*) AS requests, SUM(source = 'rest') AS rest, SUM(source = 'tool') AS tool, SUM(source = 'mcp') AS mcp, SUM(db_queries) AS db_queries, ROUND(AVG(duration_ms), 1) AS avg_ms FROM access_log ${W} GROUP BY hour ORDER BY hour`,
    );
    const { w: qw, p: qp } = where(opts, "q.");
    const QW = qw.length ? "WHERE " + qw.join(" AND ") : "";
    const by_table = q<UsageSummary["database"]["by_table"][number]>(
      `SELECT COALESCE(table_name, '(none)') AS "table", kind, COUNT(*) AS queries, ROUND(SUM(duration_ms), 2) AS total_ms, ROUND(AVG(duration_ms), 3) AS avg_ms FROM query_log q ${QW} GROUP BY table_name, kind ORDER BY queries DESC`, qp,
    );
    const by_kind = q<UsageSummary["database"]["by_kind"][number]>(
      `SELECT kind, COUNT(*) AS queries, ROUND(SUM(duration_ms), 2) AS total_ms FROM query_log q ${QW} GROUP BY kind ORDER BY queries DESC`, qp,
    );
    const slowest = q<AccessLogRow>(`SELECT * FROM access_log ${W} ORDER BY duration_ms DESC LIMIT 5`);

    return {
      window: { since: opts.since ?? null, until: opts.until ?? null, ...bounds },
      process: { started_at: processTotals.startedAt, uptime_s: Math.round(process.uptime()), db_queries_total: processTotals.queries, db_ms_total: Math.round(processTotals.ms) },
      totals: { ...totals, errors: totals.errors ?? 0, db_queries: totals.db_queries ?? 0, db_ms: totals.db_ms ?? 0, avg_ms: totals.avg_ms ?? 0, max_ms: totals.max_ms ?? 0 },
      by_source, routes, tools, mcp_methods, per_hour, database: { by_table, by_kind }, slowest,
    };
  },
};
