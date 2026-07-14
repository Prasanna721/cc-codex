#!/usr/bin/env node

import http from "node:http";
import { readFileSync } from "node:fs";

const MODEL_PREFIX = "claude-codex-";
const port = Number(process.env.CLAUDE_CODEX_GATEWAY_PORT ?? argumentValue("--port") ?? 18316);
const proxyBaseUrl = new URL(process.env.CLAUDE_CODEX_PROXY_BASE_URL ?? "http://127.0.0.1:18317");
const keyPath = process.env.CLAUDE_CODEX_PROXY_KEY_PATH;

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error(`Invalid gateway port: ${port}`);
}
if (!keyPath) throw new Error("CLAUDE_CODEX_PROXY_KEY_PATH is required");

const localKey = readFileSync(keyPath, "utf8").trim();
const server = http.createServer((request, response) => {
  void handle(request, response).catch((error) => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json" });
    }
    response.end(JSON.stringify({ type: "error", error: { type: "gateway_error", message: error.message } }));
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`claude-codex gateway listening on http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

async function handle(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `127.0.0.1:${port}`}`);
  if (url.pathname === "/healthz") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: "ok", service: "claude-codex-gateway" }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/models") {
    process.stdout.write("gateway model discovery request\n");
    if (!authorized(request)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid local gateway credential" } }));
      return;
    }
    await serveModels(request, response, url);
    return;
  }

  if (
    request.method === "POST" &&
    (url.pathname === "/v1/messages" || url.pathname === "/v1/messages/count_tokens")
  ) {
    const body = await readBody(request, 64 * 1024 * 1024);
    const rewritten = rewriteModel(body, request.headers["x-claude-codex-model"]);
    proxyRequest(request, response, url, rewritten);
    return;
  }

  proxyRequest(request, response, url);
}

function authorized(request) {
  const authorization = String(request.headers.authorization ?? "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const apiKey = request.headers["x-api-key"];
  return bearer === localKey || apiKey === localKey;
}

async function serveModels(request, response, url) {
  const upstream = new URL(`${url.pathname}${url.search}`, proxyBaseUrl);
  const result = await fetch(upstream, {
    headers: {
      Authorization: `Bearer ${localKey}`,
      "Anthropic-Version": String(request.headers["anthropic-version"] ?? "2023-06-01"),
      "User-Agent": "claude-cli/claude-codex-gateway",
    },
    signal: AbortSignal.timeout(5_000),
  });
  const text = await result.text();
  if (!result.ok) {
    response.writeHead(result.status, { "content-type": result.headers.get("content-type") ?? "application/json" });
    response.end(text);
    return;
  }
  const body = JSON.parse(text);
  const models = (body?.data ?? [])
    .filter((model) => typeof model?.id === "string" && model.id.startsWith(MODEL_PREFIX))
    .map((model) => ({
      type: "model",
      id: model.id,
      display_name: model.display_name ?? model.id,
      created_at: model.created_at ?? new Date(0).toISOString(),
    }));
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({
    data: models,
    has_more: false,
    first_id: models[0]?.id ?? null,
    last_id: models.at(-1)?.id ?? null,
  }));
}

function rewriteModel(body, selectedHeader) {
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  const selected = Array.isArray(selectedHeader) ? selectedHeader[0] : selectedHeader;
  if (!selected?.startsWith(MODEL_PREFIX) || typeof payload.model !== "string") return body;
  if (!isClaudeAuxiliaryModel(payload.model)) return body;
  payload.model = selected;
  return Buffer.from(JSON.stringify(payload));
}

function isClaudeAuxiliaryModel(model) {
  if (model.startsWith(MODEL_PREFIX)) return false;
  if (model.startsWith("claude-fable-5-dd-")) return false;
  return model.startsWith("claude-") || ["default", "best", "fable", "opus", "sonnet", "haiku", "opusplan"].includes(model);
}

function proxyRequest(request, response, url, body = null) {
  const upstreamUrl = new URL(`${url.pathname}${url.search}`, proxyBaseUrl);
  const headers = { ...request.headers, host: upstreamUrl.host };
  delete headers["x-claude-codex-model"];
  if (body) {
    headers["content-length"] = String(body.length);
    delete headers["transfer-encoding"];
  }
  const upstream = http.request(
    {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port,
      method: request.method,
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "proxy_error", message: error.message } }));
  });
  request.on("aborted", () => upstream.destroy());
  if (body) upstream.end(body);
  else request.pipe(upstream);
}

function readBody(request, limit) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectPromise(new Error("request body exceeds 64 MiB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolvePromise(Buffer.concat(chunks)));
    request.on("error", rejectPromise);
  });
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
