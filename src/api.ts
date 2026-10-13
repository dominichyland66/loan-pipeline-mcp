import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { customers, orders } from "./db.js";

export const api = Router();

const idParam = z.coerce.number().int().positive();

const CustomerInput = z.object({
  name: z.string().min(1, "name is required"),
  email: z.string().email().optional().nullable(),
});

const OrderInput = z.object({
  product: z.string().min(1, "product is required"),
  quantity: z.number().positive(),
  unit: z.string().min(1).default("each"),
});

const OrderQuery = z.object({
  since: z.string().optional(),
  until: z.string().optional(),
  product: z.string().optional(),
});

function parse<T>(schema: z.ZodType<T>, data: unknown, res: Response): T | undefined {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({ error: "validation_failed", issues: result.error.issues });
    return undefined;
  }
  return result.data;
}

// --- Customers -------------------------------------------------------------

// GET /api/customers?search=jones
api.get("/customers", (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search : undefined;
  res.json(customers.list(search));
});

// POST /api/customers { name, email? }
api.post("/customers", (req, res) => {
  const body = parse(CustomerInput, req.body, res);
  if (!body) return;
  res.status(201).json(customers.create(body.name, body.email));
});

// GET /api/customers/:id
api.get("/customers/:id", (req, res) => {
  const id = parse(idParam, req.params.id, res);
  if (id === undefined) return;
  const customer = customers.get(id);
  if (!customer) return res.status(404).json({ error: "customer_not_found" });
  res.json(customer);
});

// DELETE /api/customers/:id  (cascades to that customer's orders)
api.delete("/customers/:id", (req, res) => {
  const id = parse(idParam, req.params.id, res);
  if (id === undefined) return;
  if (!customers.delete(id)) return res.status(404).json({ error: "customer_not_found" });
  res.status(204).end();
});

// --- Orders ----------------------------------------------------------------

// GET /api/customers/:id/orders?since=2026-09-13&until=...&product=banana
api.get("/customers/:id/orders", (req, res) => {
  const id = parse(idParam, req.params.id, res);
  if (id === undefined) return;
  if (!customers.get(id)) return res.status(404).json({ error: "customer_not_found" });
  const query = parse(OrderQuery, req.query, res);
  if (!query) return;
  res.json(orders.listForCustomer(id, query));
});

// POST /api/customers/:id/orders { product, quantity, unit? }
api.post("/customers/:id/orders", (req, res) => {
  const id = parse(idParam, req.params.id, res);
  if (id === undefined) return;
  if (!customers.get(id)) return res.status(404).json({ error: "customer_not_found" });
  const body = parse(OrderInput, req.body, res);
  if (!body) return;
  res.status(201).json(orders.create(id, body.product, body.quantity, body.unit));
});

// DELETE /api/orders/:id
api.delete("/orders/:id", (req, res) => {
  const id = parse(idParam, req.params.id, res);
  if (id === undefined) return;
  if (!orders.delete(id)) return res.status(404).json({ error: "order_not_found" });
  res.status(204).end();
});

// Error handler (malformed JSON etc.)
api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as { status?: number }).status ?? 500;
  res.status(status).json({ error: status === 500 ? "internal_error" : String((err as Error).message) });
});
