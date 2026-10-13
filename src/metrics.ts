import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync, StatementSync } from "node:sqlite";

// Per-request metrics. The access-log middleware opens a context for each
// HTTP request; the instrumented SQLite connection records every statement
// run inside that context, so each logged request knows how many queries it
// caused and how long they took.

export interface QueryRecord {
  kind: string;          // SELECT, INSERT, UPDATE, DELETE, PRAGMA, OTHER
  table: string | null;  // first table named in the statement
  ms: number;
}

export interface RequestMetrics {
  queries: QueryRecord[];
}

export const requestContext = new AsyncLocalStorage<RequestMetrics>();

/** Process-wide totals since start, including work outside any request (schema, seeding). */
export const processTotals = { queries: 0, ms: 0, startedAt: new Date().toISOString() };

const KIND = /^\s*(SELECT|INSERT|UPDATE|DELETE|PRAGMA|CREATE|BEGIN|COMMIT|ROLLBACK)/i;
const TABLE = /\b(?:FROM|INTO|UPDATE|TABLE IF NOT EXISTS|TABLE)\s+([a-z_]+)/i;
const SKIP = new Set(["BEGIN", "COMMIT", "ROLLBACK"]);

export function classify(sql: string): { kind: string; table: string | null } {
  const kind = KIND.exec(sql)?.[1].toUpperCase() ?? "OTHER";
  const table = kind === "PRAGMA" ? null : (TABLE.exec(sql)?.[1] ?? null);
  return { kind, table };
}

function record(sql: string, ms: number) {
  const { kind, table } = classify(sql);
  if (SKIP.has(kind)) return;           // transaction control is not a query
  processTotals.queries++;
  processTotals.ms += ms;
  requestContext.getStore()?.queries.push({ kind, table, ms });
}

/**
 * Wraps db.prepare and db.exec so every statement is timed and attributed to
 * the current request. Returns the original prepare, for the access log's own
 * writes so they do not count themselves.
 */
export function instrument(db: DatabaseSync): (sql: string) => StatementSync {
  const rawPrepare = db.prepare.bind(db);
  const rawExec = db.exec.bind(db);

  const timed = <F extends (...args: never[]) => unknown>(fn: F, sql: string): F =>
    ((...args: never[]) => {
      const t = performance.now();
      try {
        return fn(...args);
      } finally {
        record(sql, performance.now() - t);
      }
    }) as F;

  (db as { prepare: (sql: string) => StatementSync }).prepare = (sql: string) => {
    const stmt = rawPrepare(sql);
    for (const m of ["all", "get", "run", "iterate"] as const) {
      const original = (stmt[m] as (...args: never[]) => unknown).bind(stmt);
      (stmt as unknown as Record<string, unknown>)[m] = timed(original, sql);
    }
    return stmt;
  };
  (db as { exec: (sql: string) => void }).exec = (sql: string) => timed(rawExec, sql)(sql as never);

  return rawPrepare;
}
