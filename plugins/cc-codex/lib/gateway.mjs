#!/usr/bin/env node

import http from "node:http";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { applySessionRoutingHeaders } from "./fast.mjs";
import {
  TRACE_ID_HEADER,
  createRequestTrace,
  traceModeEnabled,
} from "./trace.mjs";

const MODEL_PREFIX = "claude-codex-";
const port = Number(process.env.CLAUDE_CODEX_GATEWAY_PORT ?? argumentValue("--port") ?? 18316);
const proxyBaseUrl = new URL(process.env.CLAUDE_CODEX_PROXY_BASE_URL ?? "http://127.0.0.1:18317");
const keyPath = process.env.CLAUDE_CODEX_PROXY_KEY_PATH;
const stateDir = process.env.CLAUDE_CODEX_STATE_DIR;
const tracing = traceModeEnabled();
const tracePath = resolve(
  process.env.CLAUDE_CODEX_TRACE_PATH ??
    join(stateDir ?? process.cwd(), "logs", "request-trace.jsonl"),
);

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error(`Invalid gateway port: ${port}`);
}
if (!keyPath) throw new Error("CLAUDE_CODEX_PROXY_KEY_PATH is required");

const localKey = readFileSync(keyPath, "utf8").trim();
const server = http.createServer((request, response) => {
  const trace = createRequestTrace({
    enabled: tracing,
    path: tracePath,
    traceId: request.headers[TRACE_ID_HEADER],
  });
  const pathname = safePathname(request);
  trace.event("request_received", {
    method: request.method ?? null,
    path: pathname,
    declared_request_bytes: numericHeader(request.headers["content-length"]),
  });
  let responseFinished = false;
  response.once("finish", () => {
    responseFinished = true;
    trace.event("client_response_finished", { status_code: response.statusCode });
  });
  response.once("close", () => {
    if (!responseFinished) trace.event("client_connection_closed", { status_code: response.statusCode });
  });

  void handle(request, response, trace).catch((error) => {
    trace.event("gateway_error", {
      error_name: error?.name ?? "Error",
      error_message: error?.message ?? String(error),
    });
    if (!response.headersSent) {
      response.writeHead(502, {
        "content-type": "application/json",
        [TRACE_ID_HEADER]: trace.id,
      });
    }
    response.end(JSON.stringify({ type: "error", error: { type: "gateway_error", message: error.message } }));
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`claude-codex gateway listening on http://127.0.0.1:${port}\n`);
  if (tracing) process.stdout.write(`claude-codex request trace: ${tracePath}\n`);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

async function handle(request, response, trace) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `127.0.0.1:${port}`}`);
  if (url.pathname === "/healthz") {
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      [TRACE_ID_HEADER]: trace.id,
    });
    response.end(JSON.stringify({ status: "ok", service: "claude-codex-gateway" }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/models") {
    process.stdout.write("gateway model discovery request\n");
    if (!authorized(request)) {
      response.writeHead(401, {
        "content-type": "application/json",
        [TRACE_ID_HEADER]: trace.id,
      });
      response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid local gateway credential" } }));
      return;
    }
    await serveModels(request, response, url, trace);
    return;
  }

  if (
    request.method === "POST" &&
    (url.pathname === "/v1/messages" || url.pathname === "/v1/messages/count_tokens")
  ) {
    const bodyReadStarted = trace.now();
    const body = await readBody(request, 64 * 1024 * 1024);
    const bodyReadFinished = trace.now();
    trace.event("request_body_read", {
      request_bytes: body.length,
      body_read_ms: trace.since(bodyReadStarted, bodyReadFinished),
    });
    const prepareStarted = trace.now();
    const prepared = prepareMessageBody(
      body,
      request.headers["x-claude-codex-model"],
    );
    const modelId = url.pathname === "/v1/messages" ? prepared.modelId : null;
    const prepareFinished = trace.now();
    trace.event("request_prepared", {
      model: modelId,
      model_rewritten: prepared.rewritten,
      prepare_ms: trace.since(prepareStarted, prepareFinished),
    });
    proxyRequest(request, response, url, prepared.body, {
      modelId,
      trace,
      bodyReadMs: trace.since(bodyReadStarted, bodyReadFinished),
      prepareMs: trace.since(prepareStarted, prepareFinished),
    });
    return;
  }

  proxyRequest(request, response, url, null, { trace });
}

function authorized(request) {
  const authorization = String(request.headers.authorization ?? "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const apiKey = request.headers["x-api-key"];
  return bearer === localKey || apiKey === localKey;
}

async function serveModels(request, response, url, trace) {
  const upstream = new URL(`${url.pathname}${url.search}`, proxyBaseUrl);
  const upstreamStarted = trace.now();
  trace.event("model_discovery_upstream_started");
  const result = await fetch(upstream, {
    headers: {
      Authorization: `Bearer ${localKey}`,
      "Anthropic-Version": String(request.headers["anthropic-version"] ?? "2023-06-01"),
      "User-Agent": "claude-cli/claude-codex-gateway",
    },
    signal: AbortSignal.timeout(5_000),
  });
  const headersAt = trace.now();
  trace.event("model_discovery_headers_received", {
    upstream_status: result.status,
    upstream_headers_ms: trace.since(upstreamStarted, headersAt),
  });
  const text = await result.text();
  trace.event("model_discovery_body_received", {
    upstream_bytes: Buffer.byteLength(text),
    upstream_total_ms: trace.since(upstreamStarted),
  });
  if (!result.ok) {
    response.writeHead(result.status, {
      "content-type": result.headers.get("content-type") ?? "application/json",
      [TRACE_ID_HEADER]: trace.id,
    });
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
  response.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
    [TRACE_ID_HEADER]: trace.id,
  });
  response.end(JSON.stringify({
    data: models,
    has_more: false,
    first_id: models[0]?.id ?? null,
    last_id: models.at(-1)?.id ?? null,
  }));
}

function prepareMessageBody(body, selectedHeader) {
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return { body, modelId: null, rewritten: false };
  }
  const selected = Array.isArray(selectedHeader) ? selectedHeader[0] : selectedHeader;
  let rewritten = false;
  if (
    selected?.startsWith(MODEL_PREFIX) &&
    typeof payload.model === "string" &&
    isClaudeAuxiliaryModel(payload.model)
  ) {
    payload.model = selected;
    rewritten = true;
  }
  return {
    body: rewritten ? Buffer.from(JSON.stringify(payload)) : body,
    modelId: typeof payload.model === "string" ? payload.model : null,
    rewritten,
  };
}

function isClaudeAuxiliaryModel(model) {
  if (model.startsWith(MODEL_PREFIX)) return false;
  if (model.startsWith("claude-fable-5-dd-")) return false;
  return model.startsWith("claude-") || ["default", "best", "fable", "opus", "sonnet", "haiku", "opusplan"].includes(model);
}

function proxyRequest(
  request,
  response,
  url,
  body = null,
  { modelId = null, trace, bodyReadMs = null, prepareMs = null } = {},
) {
  const upstreamUrl = new URL(`${url.pathname}${url.search}`, proxyBaseUrl);
  const headers = {
    ...applySessionRoutingHeaders(request.headers, stateDir, { modelId }),
    host: upstreamUrl.host,
  };
  delete headers["x-claude-codex-model"];
  delete headers[TRACE_ID_HEADER];
  if (body) {
    headers["content-length"] = String(body.length);
    delete headers["transfer-encoding"];
  }
  const upstreamStarted = trace.now();
  trace.event("proxy_request_started", {
    upstream_origin: upstreamUrl.origin,
    method: request.method ?? null,
    path: upstreamUrl.pathname,
    model: modelId,
  });
  let upstreamHeadersAt = null;
  let firstUpstreamByteAt = null;
  let firstDownstreamByteAt = null;
  let upstreamBytes = 0;
  let downstreamBytes = 0;
  let requestBytes = body?.length ?? 0;
  let requestBodyRecorded = Boolean(body);
  let responseFinished = false;
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
      upstreamHeadersAt = trace.now();
      const responseHeaders = {
        ...upstreamResponse.headers,
        [TRACE_ID_HEADER]: trace.id,
      };
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      trace.event("proxy_response_headers", {
        upstream_status: upstreamResponse.statusCode ?? 502,
        proxy_wait_headers_ms: trace.since(upstreamStarted, upstreamHeadersAt),
      });

      upstreamResponse.on("data", (chunk) => {
        upstreamBytes += chunk.length;
        if (!firstUpstreamByteAt) {
          firstUpstreamByteAt = trace.now();
          trace.event("proxy_first_response_byte", {
            gateway_ttft_ms: trace.since(trace.startedNs, firstUpstreamByteAt),
            proxy_to_first_byte_ms: trace.since(upstreamStarted, firstUpstreamByteAt),
            headers_to_first_byte_ms: trace.since(upstreamHeadersAt, firstUpstreamByteAt),
          });
        }
        downstreamBytes += chunk.length;
        const shouldContinue = response.write(chunk, () => {
          if (!firstDownstreamByteAt) {
            firstDownstreamByteAt = trace.now();
            trace.event("client_first_response_byte", {
              gateway_ttft_ms: trace.since(trace.startedNs, firstDownstreamByteAt),
              relay_ms: trace.since(firstUpstreamByteAt, firstDownstreamByteAt),
            });
          }
        });
        if (!shouldContinue) {
          upstreamResponse.pause();
          response.once("drain", () => upstreamResponse.resume());
        }
      });
      upstreamResponse.once("end", () => {
        const upstreamEndedAt = trace.now();
        trace.event("proxy_response_stream_ended", {
          upstream_bytes: upstreamBytes,
          stream_ms: firstUpstreamByteAt
            ? trace.since(firstUpstreamByteAt, upstreamEndedAt)
            : null,
        });
        response.end();
      });
      upstreamResponse.once("aborted", () => {
        trace.event("proxy_response_aborted", { upstream_bytes: upstreamBytes });
        response.destroy(new Error("CLIProxyAPI aborted the response stream"));
      });
      upstreamResponse.once("error", (error) => {
        trace.event("proxy_response_error", {
          error_name: error.name,
          error_message: error.message,
          upstream_bytes: upstreamBytes,
        });
        response.destroy(error);
      });
    },
  );
  upstream.once("socket", (socket) => {
    trace.event("proxy_socket_assigned", {
      socket_reused: upstream.reusedSocket === true || socket.connecting === false,
    });
  });
  upstream.once("finish", () => {
    if (!requestBodyRecorded) {
      requestBodyRecorded = true;
      trace.event("request_body_streamed", {
        request_bytes: requestBytes,
        body_stream_ms: trace.since(upstreamStarted),
      });
    }
    trace.event("proxy_request_sent", {
      request_bytes: requestBytes,
      send_ms: trace.since(upstreamStarted),
    });
  });
  upstream.on("error", (error) => {
    trace.event("proxy_request_error", {
      error_name: error.name,
      error_message: error.message,
    });
    if (response.destroyed) return;
    if (!response.headersSent) {
      response.writeHead(502, {
        "content-type": "application/json",
        [TRACE_ID_HEADER]: trace.id,
      });
    }
    response.end(JSON.stringify({ type: "error", error: { type: "proxy_error", message: error.message } }));
  });
  response.once("finish", () => {
    if (responseFinished) return;
    responseFinished = true;
    const finishedAt = trace.now();
    trace.event("request_complete", {
      status_code: response.statusCode,
      model: modelId,
      request_bytes: requestBytes,
      response_bytes: downstreamBytes,
      body_read_ms: bodyReadMs,
      prepare_ms: prepareMs,
      proxy_wait_headers_ms: upstreamHeadersAt
        ? trace.since(upstreamStarted, upstreamHeadersAt)
        : null,
      proxy_to_first_byte_ms: firstUpstreamByteAt
        ? trace.since(upstreamStarted, firstUpstreamByteAt)
        : null,
      relay_ms: firstUpstreamByteAt && firstDownstreamByteAt
        ? trace.since(firstUpstreamByteAt, firstDownstreamByteAt)
        : null,
      stream_ms: firstUpstreamByteAt
        ? trace.since(firstUpstreamByteAt, finishedAt)
        : null,
      gateway_ttft_ms: firstDownstreamByteAt
        ? trace.since(trace.startedNs, firstDownstreamByteAt)
        : null,
      total_ms: trace.since(trace.startedNs, finishedAt),
    });
  });
  request.on("aborted", () => {
    trace.event("client_request_aborted", { request_bytes: requestBytes });
    upstream.destroy();
  });
  response.once("close", () => {
    if (!responseFinished && !upstream.destroyed) upstream.destroy();
  });
  if (!body) request.on("data", (chunk) => { requestBytes += chunk.length; });
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

function safePathname(request) {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

function numericHeader(value) {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
