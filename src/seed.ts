import { db, brokers, customers, transaction, type LoanType } from "./db.js";
import type { Status } from "./pipeline.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/** [status, days ago, actor?, note?] – the first entry is always 'received'. */
type Step = [Status, number, string?, string?];

/**
 * Demo data: a small book of loan applications spread across every stage of
 * the pipeline, with back-dated histories so questions like "what is awaiting
 * an underwriter?", "why was Greenfield Farms declined?" and "what has
 * Northgate sent us in the last month?" all have answers.
 * Only runs when the customers table is empty, so a fresh container on
 * Railway gets seeded on every deploy while existing data is left alone.
 */
export function seedIfEmpty(): boolean {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM customers").get() as unknown as { n: number };
  if (n > 0) return false;

  const insertApp = db.prepare(
    `INSERT INTO applications (customer_id, broker_id, type, amount, term_months, purpose, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEvent = db.prepare(
    "INSERT INTO application_events (application_id, from_status, to_status, actor, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );

  function application(
    customerId: number, brokerId: number | null, type: LoanType,
    amount: number, termMonths: number, purpose: string, steps: Step[],
  ) {
    const first = steps[0];
    const last = steps[steps.length - 1];
    const info = insertApp.run(customerId, brokerId, type, amount, termMonths, purpose, last[0], daysAgo(first[1]), daysAgo(last[1]));
    const id = Number(info.lastInsertRowid);
    let from: Status | null = null;
    for (const [status, days, actor, note] of steps) {
      insertEvent.run(id, from, status, actor ?? null, note ?? null, daysAgo(days));
      from = status;
    }
  }

  transaction(() => {
    // Brokers (introducers)
    const alice = brokers.create("Alice Khan", "Northgate Finance", "alice.khan@northgate.example");
    const tom = brokers.create("Tom Reilly", "Reilly & Co Brokers", "tom@reillyco.example");
    const priya = brokers.create("Priya Nair", "Castle Street Capital", "priya.nair@castlestreet.example");

    // Customers: personal borrowers have no company_name, business borrowers do.
    const mary = customers.create("Mary Brown", "mary.brown@example.com");
    const peter = customers.create("Peter Jones", "p.jones@example.com");
    const omar = customers.create("Omar Siddiqui", "omar.s@example.com");
    const helen = customers.create("Helen Cartwright", "helen@cartwrightdental.example", "Cartwright Dental Practice Ltd");
    const sam = customers.create("Sam Patel", "sam@patel-eng.example", "Patel Engineering Ltd");
    const jack = customers.create("Jack Greenfield", "jack@greenfieldfarms.example", "Greenfield Farms Ltd");

    const KYC = "KYC service";
    const AML = "AML screening";
    const OPS = "Onboarding team";
    const UW = "J. Underwriter";
    const FUND = "Funding team";

    // --- In flight, one at each open stage -----------------------------------
    // 1  Just received
    application(mary.id, alice.id, "personal", 15_000, 36, "Home improvements", [
      ["received", 2, "Alice Khan", "Full application pack received via broker portal"],
    ]);
    // 2  KYC passed
    application(peter.id, tom.id, "personal", 8_000, 24, "Car purchase", [
      ["received", 6, "Tom Reilly"],
      ["kyc_passed", 5, KYC, "Identity and address verified electronically"],
    ]);
    // 3  AML passed (direct application, no broker)
    application(peter.id, null, "personal", 12_000, 36, "Kitchen refit", [
      ["received", 20, "Online application"],
      ["kyc_passed", 19, KYC],
      ["aml_passed", 18, AML, "No sanctions or PEP matches"],
    ]);
    // 4  Awaiting underwriter decision
    application(sam.id, alice.id, "business", 120_000, 60, "CNC machinery", [
      ["received", 14, "Alice Khan", "Two years' filed accounts attached"],
      ["kyc_passed", 12, KYC, "Directors verified"],
      ["aml_passed", 11, AML],
      ["awaiting_underwriter", 10, OPS, "Assigned to commercial underwriting queue"],
    ]);
    // 5  Approved, offer not yet issued
    application(helen.id, priya.id, "personal", 10_000, 48, "Car purchase", [
      ["received", 9, "Priya Nair"],
      ["kyc_passed", 8, KYC],
      ["aml_passed", 8, AML],
      ["awaiting_underwriter", 7, OPS],
      ["approved", 1, UW, "Approved at 9.9% APR, standard terms"],
    ]);
    // 6  Offer issued, awaiting signature
    application(sam.id, alice.id, "business", 30_000, 36, "Van fleet (3 vehicles)", [
      ["received", 30, "Alice Khan"],
      ["kyc_passed", 28, KYC],
      ["aml_passed", 27, AML],
      ["awaiting_underwriter", 26, OPS],
      ["approved", 22, UW, "Approved subject to personal guarantee"],
      ["offer_issued", 21, FUND, "Offer letter and PG sent for e-signature"],
    ]);

    // --- Completed ---------------------------------------------------------
    // 7  Funded business loan
    application(helen.id, priya.id, "business", 45_000, 48, "Surgery refurbishment", [
      ["received", 25, "Priya Nair"],
      ["kyc_passed", 23, KYC],
      ["aml_passed", 22, AML],
      ["awaiting_underwriter", 20, OPS],
      ["approved", 18, UW, "Strong cash flow, 1.9x cover"],
      ["offer_issued", 16, FUND],
      ["funded", 9, FUND, "Funds released to practice account"],
    ]);
    // 8  Funded personal loan, older (outside "last month")
    application(mary.id, alice.id, "personal", 3_000, 12, "Holiday", [
      ["received", 70, "Alice Khan"],
      ["kyc_passed", 69, KYC],
      ["aml_passed", 69, AML],
      ["awaiting_underwriter", 68, OPS],
      ["approved", 66, UW],
      ["offer_issued", 65, FUND],
      ["funded", 55, FUND],
    ]);
    // 9  Declined by the underwriter
    application(jack.id, priya.id, "business", 250_000, 84, "Grain store construction", [
      ["received", 40, "Priya Nair", "Includes projections for new storage contract"],
      ["kyc_passed", 38, KYC],
      ["aml_passed", 37, AML],
      ["awaiting_underwriter", 35, OPS],
      ["declined", 30, UW, "Affordability: debt service cover 1.1x, below 1.25x minimum"],
    ]);
    // 10 Failed KYC
    application(omar.id, tom.id, "personal", 5_000, 12, "Debt consolidation", [
      ["received", 9, "Tom Reilly"],
      ["kyc_failed", 8, KYC, "Driving licence expired; no alternative ID supplied within 5 days"],
    ]);
    // 11 Failed AML
    application(jack.id, tom.id, "personal", 20_000, 60, "Land Rover purchase", [
      ["received", 12, "Tom Reilly"],
      ["kyc_passed", 11, KYC],
      ["aml_failed", 10, AML, "Unresolved adverse media match escalated to compliance; application closed"],
    ]);
    // 12 Withdrawn by the customer
    application(omar.id, tom.id, "personal", 2_000, 12, "Laptop", [
      ["received", 50, "Tom Reilly"],
      ["kyc_passed", 49, KYC],
      ["withdrawn", 47, "Tom Reilly", "Customer found a cheaper rate elsewhere"],
    ]);
  });
  return true;
}
