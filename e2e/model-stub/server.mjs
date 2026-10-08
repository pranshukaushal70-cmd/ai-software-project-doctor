// HTTP server for the end-to-end model stub (see stub.mjs). Listens on STUB_PORT
// (default 4010). Besides POST /v1/messages it exposes, for the tests only:
//   GET    /__stub/requests   what the stub received (kind, model, user message), newest last
//   DELETE /__stub/requests   forget them
//   GET    /__stub/health
// Request headers (including x-api-key) are never stored or printed.
import { createServer } from "node:http";
import { requestKind, respond, userText } from "./stub.mjs";

const PORT = Number(process.env.STUB_PORT ?? 4010);
const MAX_BODY = 8 * 1024 * 1024;
const MAX_RECORDED = 200;
const recorded = [];

const send = (res, status, json) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(json));
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stub");
  if (req.method === "GET" && url.pathname === "/__stub/health") return send(res, 200, { ok: true });
  if (url.pathname === "/__stub/requests") {
    if (req.method === "GET") return send(res, 200, { requests: recorded });
    if (req.method === "DELETE") {
      recorded.length = 0;
      return send(res, 200, { cleared: true });
    }
  }
  if (req.method !== "POST" || url.pathname !== "/v1/messages") return send(res, 404, { type: "error", error: { type: "not_found_error", message: "Not found" } });
  // Like the real API: a request without a key is rejected (the key's value is not checked or kept).
  if (!req.headers["x-api-key"]) return send(res, 401, { type: "error", error: { type: "authentication_error", message: "Missing x-api-key" } });

  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY) req.destroy();
    else chunks.push(c);
  });
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Body is not JSON" } });
    }
    recorded.push({ kind: requestKind(body), model: typeof body.model === "string" ? body.model : null, user: userText(body), at: new Date().toISOString() });
    if (recorded.length > MAX_RECORDED) recorded.shift();
    const { status, json } = respond(body);
    console.log(JSON.stringify({ msg: "stub request", kind: requestKind(body), status }));
    send(res, status, json);
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(JSON.stringify({ msg: "model stub listening", port: PORT })));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
