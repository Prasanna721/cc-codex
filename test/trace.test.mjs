import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ROOT } from "../plugins/cc-codex/lib/core.mjs";
import {
  TRACE_ID_HEADER,
  createRequestTrace,
  popProxyUsageRecords,
  readTraceRecords,
} from "../plugins/cc-codex/lib/trace.mjs";

test("gateway trace attributes buffering, upstream TTFT, relay, streaming, and total time", async () => {
  const root = mkdtempSync(join(tmpdir(), "cc-codex-trace-gateway-"));
  const keyPath = join(root, "proxy.key");
  const tracePath = join(root, "logs", "request-trace.jsonl");
  const key = "a".repeat(64);
  const traceId = "trace-integration-0001";
  const secretPrompt = "do-not-log-this-prompt-7cf34d";
  writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });

  const proxy = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the complete translated request before returning response headers.
    }
    await delay(20);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    await delay(25);
    response.write("event: message_start\ndata: {\"type\":\"message_start\"}\n\n");
    await delay(20);
    response.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
  });

  let gateway = null;
  try {
    const proxyPort = await listen(proxy);
    const gatewayPort = await freePort();
    gateway = spawn(
      process.execPath,
      [join(ROOT, "lib", "gateway.mjs"), "--port", String(gatewayPort)],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          CLAUDE_CODEX_GATEWAY_PORT: String(gatewayPort),
          CLAUDE_CODEX_PROXY_BASE_URL: `http://127.0.0.1:${proxyPort}`,
          CLAUDE_CODEX_PROXY_KEY_PATH: keyPath,
          CLAUDE_CODEX_STATE_DIR: root,
          CLAUDE_CODEX_TRACE: "1",
          CLAUDE_CODEX_TRACE_PATH: tracePath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const childOutput = collectChildOutput(gateway);
    await waitForHealthyGateway(gatewayPort, childOutput);

    const payload = JSON.stringify({
      model: "claude-codex-bW9jay1tb2RlbA",
      max_tokens: 8,
      stream: true,
      messages: [{ role: "user", content: secretPrompt }],
    });
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
        [TRACE_ID_HEADER]: traceId,
      },
      body: payload,
    });
    const responseText = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get(TRACE_ID_HEADER), traceId);
    assert.match(responseText, /message_start/);
    assert.match(responseText, /message_stop/);

    await waitForTraceEvent(tracePath, traceId, "request_complete");
    const records = readTraceRecords(tracePath).filter((record) => record.trace_id === traceId);
    const events = records.map((record) => record.event);
    for (const expected of [
      "request_received",
      "request_body_read",
      "request_prepared",
      "proxy_request_started",
      "proxy_request_sent",
      "proxy_response_headers",
      "proxy_first_response_byte",
      "client_first_response_byte",
      "proxy_response_stream_ended",
      "request_complete",
    ]) {
      assert.ok(events.includes(expected), `missing trace event ${expected}: ${events.join(", ")}`);
    }
    assert.ok(events.indexOf("proxy_response_headers") < events.indexOf("proxy_first_response_byte"));
    assert.ok(events.indexOf("proxy_first_response_byte") < events.indexOf("request_complete"));

    const complete = records.find((record) => record.event === "request_complete");
    assert.equal(complete.status_code, 200);
    assert.equal(complete.request_bytes, Buffer.byteLength(payload));
    assert.ok(complete.response_bytes > 0);
    assert.ok(complete.body_read_ms >= 0);
    assert.ok(complete.prepare_ms >= 0);
    assert.ok(complete.proxy_wait_headers_ms >= 15, JSON.stringify(complete));
    assert.ok(complete.proxy_to_first_byte_ms >= 35, JSON.stringify(complete));
    assert.ok(complete.gateway_ttft_ms >= 35, JSON.stringify(complete));
    assert.ok(complete.stream_ms >= 15, JSON.stringify(complete));
    assert.ok(complete.total_ms >= 55, JSON.stringify(complete));
    assert.ok(complete.relay_ms >= 0);

    const rawTrace = readFileSync(tracePath, "utf8");
    assert.doesNotMatch(rawTrace, new RegExp(secretPrompt));
    assert.doesNotMatch(rawTrace, new RegExp(key));
    assert.equal(statSync(tracePath).mode & 0o777, 0o600);
  } finally {
    if (gateway) await stopChild(gateway);
    await close(proxy);
    rmSync(root, { recursive: true, force: true });
  }
});

test("request trace redacts sensitive fields and credential-shaped strings", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-codex-trace-redaction-"));
  const tracePath = join(root, "trace.jsonl");
  try {
    const trace = createRequestTrace({ enabled: true, path: tracePath, traceId: "trace-redaction-0001" });
    trace.event("redaction_check", {
      token: "sensitive-token",
      authorization: "Bearer secret-access-value",
      error_message: "Bearer secret-access-value sk-abcdefghijklmnop",
      request_bytes: 123,
    });
    const [record] = readTraceRecords(tracePath);
    assert.equal(record.token, "[redacted]");
    assert.equal(record.authorization, "[redacted]");
    assert.equal(record.error_message, "Bearer [redacted] [redacted-api-key]");
    assert.equal(record.request_bytes, 123);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLIProxy usage records expose timings but remove keys, auth indexes, headers, and failure bodies", async () => {
  const managementKey = "management-secret";
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${managementKey}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify([{
      timestamp: "2026-07-14T12:00:00.000Z",
      provider: "codex",
      executor_type: "CodexExecutor",
      model: "gpt-test",
      alias: "claude-codex-test",
      endpoint: "/v1/messages",
      auth_type: "api_key",
      api_key: "must-not-escape",
      auth_index: "private-auth-index",
      request_id: "proxy-request-id",
      reasoning_effort: "medium",
      request_service_tier: "default",
      latency_ms: 97,
      ttft_ms: 65,
      failed: false,
      fail: { status_code: 200, body: "must-not-escape" },
      response_headers: { Authorization: ["Bearer must-not-escape"] },
      tokens: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    }]));
  });
  try {
    const port = await listen(server);
    const [record] = await popProxyUsageRecords(`http://127.0.0.1:${port}`, managementKey);
    assert.equal(record.latency_ms, 97);
    assert.equal(record.ttft_ms, 65);
    assert.equal(record.status_code, 200);
    assert.equal(record.tokens.total_tokens, 4);
    assert.equal(record.api_key, undefined);
    assert.equal(record.auth_index, undefined);
    assert.equal(record.response_headers, undefined);
    assert.equal(record.fail, undefined);
    assert.doesNotMatch(JSON.stringify(record), /must-not-escape|private-auth-index/);
  } finally {
    await close(server);
  }
});

async function listen(server) {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  return server.address().port;
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => error ? rejectPromise(error) : resolvePromise());
  });
}

function collectChildOutput(child) {
  let output = "";
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  return () => output;
}

async function waitForHealthyGateway(port, output) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(250),
      });
      if (response.ok) return;
    } catch {
      // The gateway process has not bound its port yet.
    }
    await delay(25);
  }
  throw new Error(`gateway did not become ready: ${output()}`);
}

async function waitForTraceEvent(path, traceId, event) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (readTraceRecords(path).some(
      (record) => record.trace_id === traceId && record.event === event,
    )) return;
    await delay(10);
  }
  throw new Error(`trace ${traceId} did not record ${event}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    delay(2_000).then(() => child.kill("SIGKILL")),
  ]);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
