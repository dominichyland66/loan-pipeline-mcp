// Seeds demo data if the database is empty. The server does this itself on
// startup; this script exists for seeding by hand. Uses DB_PATH like the server.
// Usage: npm run seed
import { customers, applications } from "../src/db.js";
import { seedIfEmpty } from "../src/seed.js";

const seeded = seedIfEmpty();
console.log(seeded ? "Seeded demo data." : "Database already has customers; nothing done.");
console.log("Customers:", customers.list().map((c) => `${c.id}:${c.company_name ?? c.name}`).join(", "));
console.log("Pipeline:", applications.summary().filter((s) => s.count).map((s) => `${s.status}=${s.count}`).join(", "));
