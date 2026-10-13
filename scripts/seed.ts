// Seeds demo data with back-dated orders so questions like
// "how many bananas has Mary Brown bought in the last month" have an answer.
// Usage: npm run seed   (uses DB_PATH like the server does)
import { db, customers, transaction } from "../src/db.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const insertOrder = db.prepare(
  "INSERT INTO orders (customer_id, product, quantity, unit, created_at) VALUES (?, ?, ?, ?, ?)",
);

const mary = customers.list("Mary Brown")[0] ?? customers.create("Mary Brown", "mary.brown@example.com");
const jones = customers.list("Jones")[0] ?? customers.create("Peter Jones", "p.jones@example.com");
const sam = customers.list("Sam Patel")[0] ?? customers.create("Sam Patel");

transaction(() => {
  insertOrder.run(mary.id, "bananas", 6, "each", daysAgo(3));
  insertOrder.run(mary.id, "bananas", 12, "each", daysAgo(17));
  insertOrder.run(mary.id, "bananas", 8, "each", daysAgo(45)); // outside "last month"
  insertOrder.run(mary.id, "milk", 2, "litre", daysAgo(5));
  insertOrder.run(jones.id, "apples", 1.5, "kg", daysAgo(10));
  insertOrder.run(jones.id, "bread", 1, "each", daysAgo(2));
  insertOrder.run(sam.id, "oranges", 3, "kg", daysAgo(1));
});


console.log("Seeded customers:", customers.list().map((c) => `${c.id}:${c.name}`).join(", "));
console.log("Mary Brown bananas in last 30 days should total 18.");
