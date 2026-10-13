import { db, customers, transaction } from "./db.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/**
 * Demo data with back-dated orders so questions like "how many bananas has
 * Mary Brown bought in the last month" have an answer (18).
 * Only runs when the customers table is empty, so a fresh container on
 * Railway gets seeded on every deploy while existing data is left alone.
 */
export function seedIfEmpty(): boolean {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM customers").get() as unknown as { n: number };
  if (n > 0) return false;

  const insertOrder = db.prepare(
    "INSERT INTO orders (customer_id, product, quantity, unit, created_at) VALUES (?, ?, ?, ?, ?)",
  );

  transaction(() => {
    const mary = customers.create("Mary Brown", "mary.brown@example.com");
    const jones = customers.create("Peter Jones", "p.jones@example.com");
    const sam = customers.create("Sam Patel");

    insertOrder.run(mary.id, "bananas", 6, "each", daysAgo(3));
    insertOrder.run(mary.id, "bananas", 12, "each", daysAgo(17));
    insertOrder.run(mary.id, "bananas", 8, "each", daysAgo(45)); // outside "last month"
    insertOrder.run(mary.id, "milk", 2, "litre", daysAgo(5));
    insertOrder.run(jones.id, "apples", 1.5, "kg", daysAgo(10));
    insertOrder.run(jones.id, "bread", 1, "each", daysAgo(2));
    insertOrder.run(sam.id, "oranges", 3, "kg", daysAgo(1));
    insertOrder.run(sam.id, "cheese", 250, "g", daysAgo(4));
    insertOrder.run(jones.id, "cheese", 500, "g", daysAgo(12));
  });
  return true;
}
