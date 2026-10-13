import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { brokers, customers, applications, type Location } from "./db.js";
import { geocodePostcode } from "./geocode.js";
import { STATUSES, LABELS, TRANSITIONS } from "./pipeline.js";
import { about, aboutTopic, TOPICS, type Topic } from "./about.js";
import { logs } from "./accesslog.js";

export const api = Router();

const idParam = z.coerce.number().int().positive();
const StatusSchema = z.enum(STATUSES);
const LoanTypeSchema = z.enum(["personal", "business"]);
const atLeastOne = (fields: string[]) => (v: Record<string, unknown>) => fields.some((f) => v[f] !== undefined);

const BrokerInput = z.object({
  name: z.string().min(1, "name is required"),
  firm: z.string().min(1, "firm is required"),
  email: z.string().email().optional().nullable(),
});
const BrokerUpdate = z
  .object({ name: z.string().min(1).optional(), firm: z.string().min(1).optional(), email: z.string().email().optional().nullable() })
  .refine(atLeastOne(["name", "firm", "email"]), { message: "provide at least one of name, firm, email" });

const CustomerInput = z.object({
  name: z.string().min(1, "name is required"),
  email: z.string().email().optional().nullable(),
  company_name: z.string().optional().nullable(),
  postcode: z.string().optional().nullable(),   // UK postcode; geocoded via postcodes.io
});
const CustomerUpdate = z
  .object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional().nullable(),
    company_name: z.string().optional().nullable(),
    postcode: z.string().optional().nullable(),
  })
  .refine(atLeastOne(["name", "email", "company_name", "postcode"]), { message: "provide at least one of name, email, company_name, postcode" });
const LocationsQuery = z.object({
  type: LoanTypeSchema.optional(),
  search: z.string().optional(),
  located: z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean().optional()),
  format: z.enum(["json", "geojson"]).optional(),
});

/**
 * Turns a postcode from a request body into a Location: undefined = not
 * mentioned (leave as is), null = clear it. Responds with the error itself and
 * returns false when the postcode is unusable.
 */
async function resolveLocation(postcode: string | null | undefined, res: Response): Promise<Location | null | undefined | false> {
  if (postcode === undefined) return undefined;
  if (postcode === null || postcode.trim() === "") return null;
  const result = await geocodePostcode(postcode);
  if (result.ok) return result.location;
  if (result.reason === "invalid_postcode") {
    res.status(400).json({ error: "invalid_postcode", message: `'${postcode}' is not a UK postcode we can locate.` });
  } else {
    res.status(502).json({ error: "geocoding_unavailable", message: `Could not look up '${postcode}': ${result.message}. Try again shortly.` });
  }
  return false;
}

const ApplicationInput = z.object({
  type: LoanTypeSchema.optional(),              // defaults from the customer: company_name set → business
  amount: z.number().positive(),
  term_months: z.number().int().positive(),
  purpose: z.string().min(1, "purpose is required"),
  broker_id: z.number().int().positive().optional().nullable(),
  actor: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
});
const ApplicationUpdate = z
  .object({
    amount: z.number().positive().optional(),
    term_months: z.number().int().positive().optional(),
    purpose: z.string().min(1).optional(),
    broker_id: z.number().int().positive().optional().nullable(),
  })
  .refine(atLeastOne(["amount", "term_months", "purpose", "broker_id"]), { message: "provide at least one of amount, term_months, purpose, broker_id" });
const TransitionInput = z.object({
  status: StatusSchema,
  actor: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
});
const boolParam = z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean().optional());
const ApplicationQuery = z.object({
  status: StatusSchema.optional(),
  open: boolParam,
  customer: z.string().optional(),
  broker: z.string().optional(),
  type: LoanTypeSchema.optional(),
  since: z.string().optional(),
  until: z.string().optional(),
});

function parse<T>(schema: z.ZodType<T>, data: unknown, res: Response): T | undefined {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "validation_failed", issues: result.error.issues });
    return undefined;
  }
  return result.data;
}

// --- Pipeline ----------------------------------------------------------------

// GET /api/pipeline  → status definitions + how many applications sit in each
api.get("/pipeline", (_req, res) => {
  res.json({
    statuses: STATUSES.map((s) => ({ status: s, label: LABELS[s], next: TRANSITIONS[s] })),
    summary: applications.summary(),
  });
});

// --- Brokers -----------------------------------------------------------------

// GET /api/brokers?search=northgate   (matches broker name or firm)
api.get("/brokers", (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  res.json(brokers.list(search));
});

// POST /api/brokers { name, firm, email? }
api.post("/brokers", (req, res) => {
  const body = parse(BrokerInput, req.body, res);
  if (!body) return;
  res.status(201).json(brokers.create(body.name, body.firm, body.email));
});

api.get("/brokers/:id", (req, res) => {
  const id = parse(idParam, req.params.id, res);
  if (id === undefined) return;
  const broker = brokers.get(id);
  if (!broker) return res.status(404).json({ error: "broker_not_found" });
  res.json(broker);
});

api.patch("/brokers/:id", (req, res) => {
  const id = parse(idParam, req.params.id, res);
  if (id === undefined) return;
  const body = parse(BrokerUpdate, req.body, res);
  if (!body) return;
  const updated = brokers.update(id, body);
  if (!updated) return res.status(404).json({ error: "broker_not_found" });
  res.json(updated);
});

// DELETE /api/brokers/:id  (their applications stay, as direct applications)
api.delete("/brokers/:id", (req, res) => {
  const id = parse(idParam, req.params.id, res);
  if (id === undefined) return;
  if (!brokers.delete(id)) return res.status(404).json({ error: "broker_not_found" });
  res.status(204).end();
});

// --- Customers ---------------------------------------------------------------

// GET /api/customers?search=patel   (matches person or company name)
api.get("/customers", (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  res.json(customers.list(search));
});

// POST /api/customers { name, email?, company_name?, postcode? }
api.post("/customers", async (req, res) => {
  const body = parse(CustomerInput, req.body, res);
  if (!body) return;
  const location = await resolveLocation(body.postcode, res);
  if (location === false) return;
  res.status(201).json(customers.create(body.name, body.email, body.company_name, location));
});

// GET /api/customers/locations?type=business&search=leeds&located=true&format=geojson
//   → every customer with postcode, coordinates and application totals, for plotting on a map
api.get("/customers/locations", (req, res) => {
  const query = parse(LocationsQuery, req.query, res);
  if (!query) return;
  const rows = customers.locations(query);
  if (query.format !== "geojson") return res.json(rows);
  res.json({
    type: "FeatureCollection",
    features: rows
      .filter((c) => c.latitude !== null && c.longitude !== null)
      .map(({ latitude, longitude, ...props }) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [longitude, latitude] },
        properties: { ...props, type: props.company_name ? "business" : "personal" },
      })),
  });
});

api.get("/customers/:id", (req, res) => {
  const id = parse(idParam, req.params.id, res);
  if (id === undefined) return;
  const customer = customers.get(id);
  if (!customer) return res.status(404).json({ error: "customer_not_found" });
  res.json(customer);
});

// PATCH /api/customers/:id { name?, email?, company_name?, postcode? }  (null clears)
api.patch("/customers/:id", async (req, res) => {
  const id = parse(idParam, req.params.id, res);
  if (id === undefined) return;
  const body = parse(CustomerUpdate, req.body, res);
  if (!body) return;
  const location = await resolveLocation(body.postcode, res);
  if (location === false) return;
  const { postcode: _postcode, ...rest } = body;
  const updated = customers.update(id, { ...rest, location });
  if (!updated) return res.status(404).json({ error: "customer_not_found" });
  res.json(updated);
});

// DELETE /api/customers/:id  (cascades to their applications and events)
api.delete("/customers/:id", (req, res) => {
  const id = parse(idParam, req.params.id, res);
  if (id === undefined) return;
  if (!customers.delete(id)) return res.status(404).json({ error: "customer_not_found" });
  res.status(204).end();
});

// --- Applications ------------------------------------------------------------

// GET /api/customers/:id/applications?status=funded
api.get("/customers/:id/applications", (req, res) => {
  const id = parse(idParam, req.params.id, res);
  if (id === undefined) return;
  if (!customers.get(id)) return res.status(404).json({ error: "customer_not_found" });
  const query = parse(z.object({ status: StatusSchema.optional() }), req.query, res);
  if (!query) return;
  res.json(applications.listForCustomer(id, query));
});

// POST /api/customers/:id/applications { amount, term_months, purpose, type?, broker_id?, actor?, note? }
api.post("/customers/:id/applications", (req, res) => {
  const id = parse(idParam, req.params.id, res);
  if (id === undefined) return;
  const customer = customers.get(id);
  if (!customer) return res.status(404).json({ error: "customer_not_found" });
  const body = parse(ApplicationInput, req.body, res);
  if (!body) return;
  const type = body.type ?? (customer.company_name ? "business" : "personal");
  if (type === "business" && !customer.company_name) {
    return res.status(400).json({ error: "company_name_required", message: "A business application needs a customer with a company_name." });
  }
  if (body.broker_id && !brokers.get(body.broker_id)) return res.status(404).json({ error: "broker_not_found" });
  res.status(201).json(applications.create(id, { ...body, type }));
});

// GET /api/applications?status=awaiting_underwriter&open=true&customer=patel&broker=northgate&type=business&since=...&until=...
api.get("/applications", (req, res) => {
  const query = parse(ApplicationQuery, req.query, res);
  if (!query) return;
  res.json(applications.search(query));
});

// GET /api/applications/:id  → the application plus its full event history
api.get("/applications/:id", (req, res) => {
  const id = parse(idParam, req.params.id, res);
  if (id === undefined) return;
  const app = applications.get(id);
  if (!app) return res.status(404).json({ error: "application_not_found" });
  res.json({ ...app, events: applications.events(id) });
});

// POST /api/applications/:id/transition { status, actor?, note? }
api.post("/applications/:id/transition", (req, res) => {
  const id = parse(idParam, req.params.id, res);
  if (id === undefined) return;
  const body = parse(TransitionInput, req.body, res);
  if (!body) return;
  const result = applications.transition(id, body.status, body);
  if (!result.ok) {
    if (result.reason === "not_found") return res.status(404).json({ error: "application_not_found" });
    return res.status(409).json({
      error: "invalid_transition",
      from: result.from,
      to: body.status,
      allowed: result.allowed,
      message: result.allowed.length
        ? `Cannot move from ${LABELS[result.from]} to ${LABELS[body.status]}. Allowed: ${result.allowed.map((s) => LABELS[s]).join(", ")}.`
        : `${LABELS[result.from]} is a final status; the application cannot move again.`,
    });
  }
  res.json({ ...result.application, event: result.event });
});

// PATCH /api/applications/:id { amount?, term_months?, purpose?, broker_id? }
api.patch("/applications/:id", (req, res) => {
  const id = parse(idParam, req.params.id, res);
  if (id === undefined) return;
  const body = parse(ApplicationUpdate, req.body, res);
  if (!body) return;
  if (body.broker_id && !brokers.get(body.broker_id)) return res.status(404).json({ error: "broker_not_found" });
  const updated = applications.update(id, body);
  if (!updated) return res.status(404).json({ error: "application_not_found" });
  res.json(updated);
});

api.delete("/applications/:id", (req, res) => {
  const id = parse(idParam, req.params.id, res);
  if (id === undefined) return;
  if (!applications.delete(id)) return res.status(404).json({ error: "application_not_found" });
  res.status(204).end();
});

// --- About -------------------------------------------------------------------

// GET /api/about            → every section: [{ topic, title, markdown, data }]
// GET /api/about/:topic     → one section
api.get("/about", (_req, res) => res.json(about(api)));
api.get("/about/:topic", (req, res) => {
  const topic = req.params.topic as string;
  if (!(TOPICS as readonly string[]).includes(topic)) return res.status(404).json({ error: "unknown_topic", topics: TOPICS });
  res.json(aboutTopic(api, topic as Topic));
});

// --- Access logs --------------------------------------------------------------

const LogsQuery = z.object({
  since: z.string().optional(),
  until: z.string().optional(),
  source: z.enum(["rest", "tool", "mcp", "other"]).optional(),
  route: z.string().optional(),
  detail: z.string().optional(),
  status_min: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

// GET /api/logs?limit=100&since=&until=&source=rest|tool|mcp&route=applications&detail=search_app&status_min=400
api.get("/logs", (req, res) => {
  const query = parse(LogsQuery, req.query, res);
  if (!query) return;
  res.json(logs.recent(query));
});

// GET /api/logs/summary?since=&until=   → request volumes, per-route and per-tool stats, DB activity, per-hour series
api.get("/logs/summary", (req, res) => {
  const query = parse(LogsQuery.pick({ since: true, until: true }), req.query, res);
  if (!query) return;
  res.json(logs.summary(query));
});

// Error handler (malformed JSON etc.)
api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as { status?: number }).status ?? 500;
  res.status(status).json({ error: status === 500 ? "internal_error" : String((err as Error).message) });
});
