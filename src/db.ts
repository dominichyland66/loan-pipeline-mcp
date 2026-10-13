import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// SQLite file location. On Railway, mount a volume and point DB_PATH at it,
// e.g. DB_PATH=/data/app.db. Locally it defaults to ./data/app.db.
const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), "data", "app.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    product     TEXT NOT NULL,
    quantity    REAL NOT NULL,
    unit        TEXT NOT NULL DEFAULT 'each',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id, created_at);
`);

export interface Customer {
  id: number;
  name: string;
  email: string | null;
  created_at: string;
}

export interface Order {
  id: number;
  customer_id: number;
  product: string;
  quantity: number;
  unit: string;
  created_at: string;
}

export const customers = {
  list(search?: string): Customer[] {
    if (search && search.trim()) {
      return db
        .prepare("SELECT * FROM customers WHERE name LIKE ? COLLATE NOCASE ORDER BY name")
        .all(`%${search.trim()}%`) as Customer[];
    }
    return db.prepare("SELECT * FROM customers ORDER BY name").all() as Customer[];
  },
  get(id: number): Customer | undefined {
    return db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as Customer | undefined;
  },
  create(name: string, email?: string | null): Customer {
    const info = db
      .prepare("INSERT INTO customers (name, email) VALUES (?, ?)")
      .run(name.trim(), email?.trim() || null);
    return this.get(Number(info.lastInsertRowid))!;
  },
  delete(id: number): boolean {
    return db.prepare("DELETE FROM customers WHERE id = ?").run(id).changes > 0;
  },
};

export const orders = {
  listForCustomer(customerId: number, opts: { since?: string; until?: string; product?: string } = {}): Order[] {
    const where = ["customer_id = ?"];
    const params: unknown[] = [customerId];
    if (opts.since) { where.push("created_at >= ?"); params.push(opts.since); }
    if (opts.until) { where.push("created_at <= ?"); params.push(opts.until); }
    if (opts.product) { where.push("product LIKE ? COLLATE NOCASE"); params.push(`%${opts.product}%`); }
    return db
      .prepare(`SELECT * FROM orders WHERE ${where.join(" AND ")} ORDER BY created_at DESC`)
      .all(...params) as Order[];
  },
  get(id: number): Order | undefined {
    return db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as Order | undefined;
  },
  create(customerId: number, product: string, quantity: number, unit: string): Order {
    const info = db
      .prepare("INSERT INTO orders (customer_id, product, quantity, unit) VALUES (?, ?, ?, ?)")
      .run(customerId, product.trim().toLowerCase(), quantity, unit.trim().toLowerCase());
    return this.get(Number(info.lastInsertRowid))!;
  },
  delete(id: number): boolean {
    return db.prepare("DELETE FROM orders WHERE id = ?").run(id).changes > 0;
  },
};
