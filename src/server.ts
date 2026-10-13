import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { api } from "./api.js";
import { createMcpServer } from "./mcp.js";
import { seedIfEmpty } from "./seed.js";

const PORT = Number(process.env.PORT ?? 3000);
// Where the MCP tools reach the REST API. Defaults to this same process.
const API_BASE = process.env.API_BASE ?? `http://127.0.0.1:${PORT}/api`;

// Demo convenience: a fresh (empty) database gets sample data on startup.
// Railway's disk is ephemeral, so every deploy starts clean and reseeded.
// Set SEED_DEMO_DATA=false to disable.
if (process.env.SEED_DEMO_DATA !== "false" && seedIfEmpty()) {
  console.log("Seeded demo data into empty database");
}

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    name: "customer-orders-mcp",
    api: "/api/customers",
    mcp: "/mcp",
    health: "/health",
  });
});
app.get("/health", (_req, res) => res.json({ ok: true }));

// 1. Plain REST API
app.use("/api", api);

// 2. MCP server over the top, stateless Streamable HTTP.
//    A fresh McpServer + transport per request keeps it simple and
//    horizontally scalable; no session state lives in memory.
app.post("/mcp", async (req, res) => {
  const server = createMcpServer(API_BASE);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless servers don't support server-initiated streams or sessions.
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API  http://localhost:${PORT}/api/customers`);
  console.log(`MCP  http://localhost:${PORT}/mcp`);
});
