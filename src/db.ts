import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { type Status, STATUSES, TRANSITIONS, canTransition } from "./pipeline.js";

// Uses Node's built-in SQLite (node:sqlite, Node 22.13+/24), so there is no
// native addon to compile at install time. That matters on Railway, whose
// build image has no Python or C toolchain.
//
// SQLite file location. On Railway, mount a volume and point DB_PATH at it,
// e.g. DB_PATH=/data/app.db. Locally it defaults to ./data/app.db.
const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), "data", "app.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

db.exec(`
  CREATE TABLE IF NOT EXISTS brokers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    firm       TEXT NOT NULL,
    email      TEXT,
    created_at TEXT NOT NULL DEFAULT (${NOW})
  );

  CREATE TABLE IF NOT EXISTS customers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    email        TEXT,
    company_name TEXT,                 -- set for business borrowers, NULL for personal
    created_at   TEXT NOT NULL DEFAULT (${NOW})
  );

  CREATE TABLE IF NOT EXISTS applications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    broker_id   INTEGER REFERENCES brokers(id) ON DELETE SET NULL,   -- NULL = direct application
    type        TEXT NOT NULL CHECK (type IN ('personal', 'business')),
    amount      REAL NOT NULL,         -- GBP
    term_months INTEGER NOT NULL,
    purpose     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'received',
    created_at  TEXT NOT NULL DEFAULT (${NOW}),
    updated_at  TEXT NOT NULL DEFAULT (${NOW})
  );

  CREATE TABLE IF NOT EXISTS application_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    from_status    TEXT,               -- NULL for the initial 'received' event
    to_status      TEXT NOT NULL,
    actor          TEXT,               -- who did it: 'KYC service', 'J. Underwriter', ...
    note           TEXT,
    created_at     TEXT NOT NULL DEFAULT (${NOW})
  );

  CREATE INDEX IF NOT EXISTS idx_applications_customer ON applications(customer_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_applications_status   ON applications(status);
  CREATE INDEX IF NOT EXISTS idx_events_application    ON application_events(application_id, created_at);
`);

export type LoanType = "personal" | "business";

export interface Broker {
  id: number;
  name: string;
  firm: string;
  email: string | null;
  created_at: string;
}

export interface Customer {
  id: number;
  name: string;
  email: string | null;
  company_name: string | null;
  created_at: string;
}

export interface Application {
  id: number;
  customer_id: number;
  broker_id: number | null;
  type: LoanType;
  amount: number;
  term_months: number;
  purpose: string;
  status: Status;
  created_at: string;
  updated_at: string;
}

/** An application joined with the names it is usually displayed with. */
export type ApplicationRow = Application & {
  customer_name: string;
  company_name: string | null;
  broker_name: string | null;
  broker_firm: string | null;
};

export interface ApplicationEvent {
  id: number;
  application_id: number;
  from_status: Status | null;
  to_status: Status;
  actor: string | null;
  note: string | null;
  created_at: string;
}

export interface StatusCount {
  status: Status;
  count: number;
  total_amount: number;
}

/** Run `fn` inside a transaction, rolling back if it throws. */
export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const clean = (s: string | null | undefined) => s?.trim() || null;

// --- Brokers -----------------------------------------------------------------

export const brokers = {
  list(search?: string): Broker[] {
    if (search?.trim()) {
      const q = `%${search.trim()}%`;
      return db
        .prepare("SELECT * FROM brokers WHERE name LIKE ? COLLATE NOCASE OR firm LIKE ? COLLATE NOCASE ORDER BY firm, name")
        .all(q, q) as unknown as Broker[];
    }
    return db.prepare("SELECT * FROM brokers ORDER BY firm, name").all() as unknown as Broker[];
  },
  get(id: number): Broker | undefined {
    return db.prepare("SELECT * FROM brokers WHERE id = ?").get(id) as unknown as Broker | undefined;
  },
  create(name: string, firm: string, email?: string | null): Broker {
    const info = db.prepare("INSERT INTO brokers (name, firm, email) VALUES (?, ?, ?)").run(name.trim(), firm.trim(), clean(email));
    return this.get(Number(info.lastInsertRowid))!;
  },
  update(id: number, changes: { name?: string; firm?: string; email?: string | null }): Broker | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const name = changes.name !== undefined ? changes.name.trim() : existing.name;
    const firm = changes.firm !== undefined ? changes.firm.trim() : existing.firm;
    const email = changes.email !== undefined ? clean(changes.email) : existing.email;
    db.prepare("UPDATE brokers SET name = ?, firm = ?, email = ? WHERE id = ?").run(name, firm, email, id);
    return this.get(id);
  },
  delete(id: number): boolean {
    return db.prepare("DELETE FROM brokers WHERE id = ?").run(id).changes > 0;
  },
};

// --- Customers ---------------------------------------------------------------

export const customers = {
  /** Partial, case-insensitive match on the person's name or their company. */
  list(search?: string): Customer[] {
    if (search?.trim()) {
      const q = `%${search.trim()}%`;
      return db
        .prepare("SELECT * FROM customers WHERE name LIKE ? COLLATE NOCASE OR company_name LIKE ? COLLATE NOCASE ORDER BY name")
        .all(q, q) as unknown as Customer[];
    }
    return db.prepare("SELECT * FROM customers ORDER BY name").all() as unknown as Customer[];
  },
  get(id: number): Customer | undefined {
    return db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as unknown as Customer | undefined;
  },
  create(name: string, email?: string | null, companyName?: string | null): Customer {
    const info = db
      .prepare("INSERT INTO customers (name, email, company_name) VALUES (?, ?, ?)")
      .run(name.trim(), clean(email), clean(companyName));
    return this.get(Number(info.lastInsertRowid))!;
  },
  update(id: number, changes: { name?: string; email?: string | null; company_name?: string | null }): Customer | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const name = changes.name !== undefined ? changes.name.trim() : existing.name;
    // undefined = leave as is, null or "" = clear it
    const email = changes.email !== undefined ? clean(changes.email) : existing.email;
    const company = changes.company_name !== undefined ? clean(changes.company_name) : existing.company_name;
    db.prepare("UPDATE customers SET name = ?, email = ?, company_name = ? WHERE id = ?").run(name, email, company, id);
    return this.get(id);
  },
  delete(id: number): boolean {
    return db.prepare("DELETE FROM customers WHERE id = ?").run(id).changes > 0;
  },
};

// --- Applications ------------------------------------------------------------

const APP_SELECT = `
  SELECT a.*, c.name AS customer_name, c.company_name, b.name AS broker_name, b.firm AS broker_firm
  FROM applications a
  JOIN customers c ON c.id = a.customer_id
  LEFT JOIN brokers b ON b.id = a.broker_id`;

export interface ApplicationSearch {
  status?: Status;
  open?: boolean;        // true = only statuses that can still move
  customer?: string;     // partial match on customer name or company
  broker?: string;       // partial match on broker name or firm
  type?: LoanType;
  since?: string;        // ISO date, inclusive, on created_at
  until?: string;
}

export interface NewApplication {
  type: LoanType;
  amount: number;
  term_months: number;
  purpose: string;
  broker_id?: number | null;
  actor?: string | null;
  note?: string | null;
}

export type TransitionResult =
  | { ok: true; application: ApplicationRow; event: ApplicationEvent }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_transition"; from: Status; allowed: Status[] };

export const applications = {
  /** Search across all customers, newest first. All filters optional. */
  search(opts: ApplicationSearch = {}): ApplicationRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.status) { where.push("a.status = ?"); params.push(opts.status); }
    if (opts.open) {
      const open = STATUSES.filter((s) => TRANSITIONS[s].length > 0);
      where.push(`a.status IN (${open.map(() => "?").join(",")})`);
      params.push(...open);
    }
    if (opts.customer) {
      where.push("(c.name LIKE ? COLLATE NOCASE OR c.company_name LIKE ? COLLATE NOCASE)");
      params.push(`%${opts.customer}%`, `%${opts.customer}%`);
    }
    if (opts.broker) {
      where.push("(b.name LIKE ? COLLATE NOCASE OR b.firm LIKE ? COLLATE NOCASE)");
      params.push(`%${opts.broker}%`, `%${opts.broker}%`);
    }
    if (opts.type) { where.push("a.type = ?"); params.push(opts.type); }
    if (opts.since) { where.push("a.created_at >= ?"); params.push(opts.since); }
    if (opts.until) { where.push("a.created_at <= ?"); params.push(opts.until); }
    const sql = `${APP_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.created_at DESC LIMIT 200`;
    return db.prepare(sql).all(...params) as unknown as ApplicationRow[];
  },
  listForCustomer(customerId: number, opts: { status?: Status } = {}): ApplicationRow[] {
    const where = ["a.customer_id = ?"];
    const params: (string | number)[] = [customerId];
    if (opts.status) { where.push("a.status = ?"); params.push(opts.status); }
    return db
      .prepare(`${APP_SELECT} WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC`)
      .all(...params) as unknown as ApplicationRow[];
  },
  get(id: number): ApplicationRow | undefined {
    return db.prepare(`${APP_SELECT} WHERE a.id = ?`).get(id) as unknown as ApplicationRow | undefined;
  },
  events(applicationId: number): ApplicationEvent[] {
    return db
      .prepare("SELECT * FROM application_events WHERE application_id = ? ORDER BY created_at, id")
      .all(applicationId) as unknown as ApplicationEvent[];
  },
  /** Creates the application in 'received' and writes its first event. */
  create(customerId: number, input: NewApplication): ApplicationRow {
    return transaction(() => {
      const info = db
        .prepare("INSERT INTO applications (customer_id, broker_id, type, amount, term_months, purpose) VALUES (?, ?, ?, ?, ?, ?)")
        .run(customerId, input.broker_id ?? null, input.type, input.amount, input.term_months, input.purpose.trim());
      const id = Number(info.lastInsertRowid);
      db.prepare("INSERT INTO application_events (application_id, from_status, to_status, actor, note) VALUES (?, NULL, 'received', ?, ?)")
        .run(id, clean(input.actor), clean(input.note));
      return this.get(id)!;
    });
  },
  /** Moves an application along the pipeline, enforcing allowed transitions. */
  transition(id: number, to: Status, meta: { actor?: string | null; note?: string | null } = {}): TransitionResult {
    return transaction(() => {
      const current = this.get(id);
      if (!current) return { ok: false, reason: "not_found" } as const;
      if (!canTransition(current.status, to)) {
        return { ok: false, reason: "invalid_transition", from: current.status, allowed: TRANSITIONS[current.status] } as const;
      }
      db.prepare(`UPDATE applications SET status = ?, updated_at = ${NOW} WHERE id = ?`).run(to, id);
      const info = db
        .prepare("INSERT INTO application_events (application_id, from_status, to_status, actor, note) VALUES (?, ?, ?, ?, ?)")
        .run(id, current.status, to, clean(meta.actor), clean(meta.note));
      const event = db.prepare("SELECT * FROM application_events WHERE id = ?").get(Number(info.lastInsertRowid)) as unknown as ApplicationEvent;
      return { ok: true, application: this.get(id)!, event } as const;
    });
  },
  /** Edits the request itself (not its status). broker_id null = make it direct. */
  update(id: number, changes: { amount?: number; term_months?: number; purpose?: string; broker_id?: number | null }): ApplicationRow | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const amount = changes.amount ?? existing.amount;
    const term = changes.term_months ?? existing.term_months;
    const purpose = changes.purpose !== undefined ? changes.purpose.trim() : existing.purpose;
    const broker = changes.broker_id !== undefined ? changes.broker_id : existing.broker_id;
    db.prepare(`UPDATE applications SET amount = ?, term_months = ?, purpose = ?, broker_id = ?, updated_at = ${NOW} WHERE id = ?`)
      .run(amount, term, purpose, broker, id);
    return this.get(id);
  },
  delete(id: number): boolean {
    return db.prepare("DELETE FROM applications WHERE id = ?").run(id).changes > 0;
  },
  /** Count and total amount per status, in pipeline order (statuses with no applications included). */
  summary(): StatusCount[] {
    const rows = db
      .prepare("SELECT status, COUNT(*) AS count, SUM(amount) AS total_amount FROM applications GROUP BY status")
      .all() as unknown as StatusCount[];
    const byStatus = new Map(rows.map((r) => [r.status, r]));
    return STATUSES.map((s) => byStatus.get(s) ?? { status: s, count: 0, total_amount: 0 });
  },
};
