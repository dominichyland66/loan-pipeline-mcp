// Seeds demo data if the database is empty. The server does this itself on
// startup; this script exists for seeding by hand. Uses DB_PATH like the server.
// Usage: npm run seed
import { customers } from "../src/db.js";
import { seedIfEmpty } from "../src/seed.js";

const seeded = seedIfEmpty();
console.log(seeded ? "Seeded demo data." : "Database already has customers; nothing done.");
console.log("Customers:", customers.list().map((c) => `${c.id}:${c.name}`).join(", "));
