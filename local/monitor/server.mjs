import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Monitor backend is intentionally protocol-agnostic:
 * - accepts event envelopes from MCP/resource/facilitator
 * - persists them for replay
 * - streams them to dashboard in realtime via SSE
 * It never participates in verify/settle decisions.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MONITOR_PORT || 4399);
const MAX_EVENTS = Number(process.env.MONITOR_MAX_EVENTS || 2000);
const DATA_DIR = process.env.MONITOR_DATA_DIR || join(__dirname, "data");
const EVENT_LOG_FILE = join(DATA_DIR, "events.jsonl");
const PUBLIC_DIR = join(__dirname, "public");

/** @type {Array<Record<string, unknown>>} */
const events = [];
/** @type {Set<import("node:http").ServerResponse>} */
const sseClients = new Set();

const STATUS_MAP = new Set(["started", "success", "fail", "info"]);

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function normalizeStatus(value) {
  const status = typeof value === "string" ? value.toLowerCase() : "info";
  return STATUS_MAP.has(status) ? status : "info";
}

function normalizeEvent(input) {
  const now = new Date().toISOString();
  const event = input && typeof input === "object" ? input : {};

  // Monitoring is observational only: normalize and persist whatever components emit,
  // without affecting the payment control path.
  return {
    id: typeof event.id === "string" ? event.id : randomUUID(),
    traceId: typeof event.traceId === "string" ? event.traceId : randomUUID(),
    step: typeof event.step === "string" ? event.step : "unknown.step",
    status: normalizeStatus(event.status),
    ts: typeof event.ts === "string" ? event.ts : now,
    durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
    component: typeof event.component === "string" ? event.component : "unknown",
    conversationId:
      typeof event.conversationId === "string" ? event.conversationId : undefined,
    toolName: typeof event.toolName === "string" ? event.toolName : undefined,
    network: typeof event.network === "string" ? event.network : undefined,
    scheme: typeof event.scheme === "string" ? event.scheme : undefined,
    asset: typeof event.asset === "string" ? event.asset : undefined,
    amount: typeof event.amount === "string" ? event.amount : undefined,
    payTo: typeof event.payTo === "string" ? event.payTo : undefined,
    txHash: typeof event.txHash === "string" ? event.txHash : undefined,
    errorReason:
      typeof event.errorReason === "string" ? event.errorReason : undefined,
    metadata:
      event.metadata && typeof event.metadata === "object" ? event.metadata : undefined,
  };
}

function writeJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  // Guard payload size to keep monitor resilient under bursty event traffic.
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString("utf8");
      if (body.length > 1024 * 1024) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function trimEvents() {
  if (events.length <= MAX_EVENTS) {
    return;
  }
  events.splice(0, events.length - MAX_EVENTS);
}

function broadcastSSE(event) {
  // Fan out single event to all connected dashboards.
  const payload = `event: event\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

async function persistEvent(event) {
  await appendFile(EVENT_LOG_FILE, `${JSON.stringify(event)}\n`, "utf8");
}

async function ingestEvents(raw) {
  const inputs = Array.isArray(raw) ? raw : [raw];
  const normalized = inputs.map(item => normalizeEvent(item));
  for (const event of normalized) {
    // Single write path: memory(for UI), SSE(for realtime), disk(for replay).
    events.push(event);
    trimEvents();
    broadcastSSE(event);
    await persistEvent(event);
  }
  return normalized;
}

function loadEventHistory() {
  // Warm memory cache from disk so UI can render historical traces on refresh/restart.
  if (!existsSync(EVENT_LOG_FILE)) {
    return;
  }
  const content = readFileSync(EVENT_LOG_FILE, "utf8");
  const lines = content.split("\n").filter(Boolean);
  for (const line of lines.slice(-MAX_EVENTS)) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // ignore malformed lines
    }
  }
}

function serveFile(res, path, contentType) {
  readFile(path)
    .then(content => {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    })
    .catch(() => {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    });
}

await mkdir(DATA_DIR, { recursive: true });
loadEventHistory();

const server = createServer(async (req, res) => {
  const method = req.method || "GET";
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (method === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === "GET" && url.pathname === "/health") {
    writeJson(res, 200, { status: "ok", events: events.length, clients: sseClients.size });
    return;
  }

  if (method === "GET" && url.pathname === "/events") {
    // Primary query API used by UI history panel; supports trace-level filtering.
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") || 200)));
    const traceId = url.searchParams.get("traceId");
    const filtered = traceId ? events.filter(event => event.traceId === traceId) : events;
    writeJson(res, 200, { events: filtered.slice(-limit) });
    return;
  }

  if (method === "GET" && url.pathname === "/events/stream") {
    setCorsHeaders(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    sseClients.add(res);
    // Send recent snapshot first so newly opened dashboard can render state immediately.
    res.write(`event: snapshot\ndata: ${JSON.stringify(events.slice(-300))}\n\n`);

    const heartbeat = setInterval(() => {
      res.write("event: ping\ndata: {}\n\n");
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
      res.end();
    });
    return;
  }

  if (method === "POST" && (url.pathname === "/events" || url.pathname === "/events/batch")) {
    try {
      // Accept both single object and array payloads for easier emitter integration.
      const body = await readJsonBody(req);
      const inserted = await ingestEvents(body);
      writeJson(res, 200, { inserted: inserted.length });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : "Bad request" });
    }
    return;
  }

  if (method === "GET" && url.pathname === "/") {
    serveFile(res, join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
    return;
  }

  if (method === "GET" && url.pathname === "/app.js") {
    serveFile(res, join(PUBLIC_DIR, "app.js"), "application/javascript; charset=utf-8");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`x402 monitor server listening on http://127.0.0.1:${PORT}`);
  console.log(`events endpoint: POST http://127.0.0.1:${PORT}/events`);
  console.log(`stream endpoint: GET  http://127.0.0.1:${PORT}/events/stream`);
});
