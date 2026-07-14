#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  ROOT,
  ensureProxyInstalled,
  ensureState,
  gatewayAliasForModel,
  getConfig,
  renderClaudeCodexSettings,
  renderProxyConfig,
  syncLocalCodexAuth,
  syncProxyAliases,
} from "../lib/core.mjs";
import {
  TRACE_ID_HEADER,
  popProxyUsageRecords,
  readTraceRecords,
} from "../lib/trace.mjs";

const options = parseOptions(process.argv.slice(2));
const benchmarkRoot = mkdtempSync(join(tmpdir(), "cc-codex-benchmark-"));
const runtimeDir = join(tmpdir(), "cc-codex-benchmark-runtime");
const children = new Set();
const servers = new Set();

try {
  progress(`Preparing pinned CLIProxyAPI in ${runtimeDir}`);
  const bootstrapPorts = await freePorts(3);
  const bootstrapConfig = benchmarkConfig(join(benchmarkRoot, "bootstrap"), bootstrapPorts);
  bootstrapConfig.runtimeDir = runtimeDir;
  const proxyBinary = await ensureProxyInstalled(bootstrapConfig, { quiet: false });

  const report = {
    schema: "cc-codex.latency-benchmark.v1",
    captured_at: new Date().toISOString(),
    environment: {
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      claude: commandVersion("claude"),
      codex: commandVersion("codex"),
      runs_per_payload: options.runs,
      real_runs: options.realRuns,
    },
    mock_delays_ms: {
      response_headers: options.mockHeaderDelayMs,
      headers_to_first_byte: options.mockFirstByteDelayMs,
      first_byte_to_end: options.mockStreamDelayMs,
    },
    scenarios: {},
  };

  progress("Benchmarking gateway-only relay");
  report.scenarios.gateway_only = await benchmarkGatewayOnly(proxyBinary);

  progress("Benchmarking gateway + CLIProxy translation against a local Codex mock");
  report.scenarios.translated_mock = await benchmarkTranslatedMock(proxyBinary);

  if (options.real) {
    progress(`Benchmarking real Codex requests with ${options.model}`);
    report.scenarios.real = await benchmarkReal(proxyBinary);
  }

  if (options.output) {
    mkdirSync(resolve(options.output, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    progress(`Wrote ${options.output}`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await cleanup();
  rmSync(benchmarkRoot, { recursive: true, force: true });
}

async function benchmarkGatewayOnly(_proxyBinary) {
  const root = join(benchmarkRoot, "gateway-only");
  const ports = await freePorts(3);
  const config = benchmarkConfig(root, ports);
  const key = "1".repeat(64);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(config.proxyKeyPath, `${key}\n`, { mode: 0o600 });

  const mock = createMockAnthropicServer();
  const mockPort = await listen(mock);
  const gateway = await startGateway(config, key, `http://127.0.0.1:${mockPort}`);
  try {
    await runGatewayRequest(config, key, {
      model: options.model,
      payloadBytes: 1_024,
      traceId: "warmup-gateway-only",
    });

    const byPayload = {};
    for (const payloadBytes of options.payloadBytes) {
      const samples = [];
      for (let index = 0; index < options.runs; index++) {
        samples.push(await runGatewayRequest(config, key, {
          model: options.model,
          payloadBytes,
          traceId: `gateway-${payloadBytes}-${index}-${Date.now()}`,
        }));
      }
      byPayload[String(payloadBytes)] = summarizeGatewaySamples(samples, {
        expectedTtftMs: options.mockHeaderDelayMs + options.mockFirstByteDelayMs,
        expectedTotalMs:
          options.mockHeaderDelayMs + options.mockFirstByteDelayMs + options.mockStreamDelayMs,
      });
    }
    return {
      description: "Claude-compatible gateway forwarding directly to a deterministic local upstream; no CLIProxy translation.",
      gateway_startup_ms: gateway.startupMs,
      payloads: byPayload,
    };
  } finally {
    await stopProcess(gateway.child);
    await closeServer(mock);
  }
}

async function benchmarkTranslatedMock(proxyBinary) {
  const root = join(benchmarkRoot, "translated-mock");
  const ports = await freePorts(3);
  const config = benchmarkConfig(root, ports);
  config.runtimeDir = runtimeDir;
  const { key } = ensureState(config);
  const rawModel = options.model;
  const alias = gatewayAliasForModel(rawModel);

  const mock = createMockCodexServer(rawModel);
  const mockPort = await listen(mock);
  const generated = renderMockProxyConfig(
    config,
    key,
    `http://127.0.0.1:${mockPort}`,
    rawModel,
    alias,
  );
  writeFileSync(config.proxyConfigPath, generated, { mode: 0o600 });

  const proxy = await startProxy(proxyBinary, config, key);
  await waitForProxyModel(config, key, alias);
  const gateway = await startGateway(config, key, config.proxyBaseUrl);
  try {
    await drainUsage(config, key);
    await runGatewayRequest(config, key, {
      model: alias,
      selectedModel: alias,
      payloadBytes: 1_024,
      traceId: "warmup-translated-mock",
    });
    await waitForUsage(config, key);

    const byPayload = {};
    for (const payloadBytes of options.payloadBytes) {
      const samples = [];
      for (let index = 0; index < options.runs; index++) {
        const gatewaySample = await runGatewayRequest(config, key, {
          model: alias,
          selectedModel: alias,
          payloadBytes,
          traceId: `translated-${payloadBytes}-${index}-${Date.now()}`,
        });
        const usage = await waitForUsage(config, key);
        samples.push(addProxyUsage(gatewaySample, usage));
      }
      byPayload[String(payloadBytes)] = summarizeTranslatedSamples(samples);
    }
    return {
      description: "Gateway plus pinned CLIProxyAPI translating Claude Messages to Codex Responses against a deterministic local upstream.",
      proxy_startup_ms: proxy.startupMs,
      gateway_startup_ms: gateway.startupMs,
      payloads: byPayload,
    };
  } finally {
    await stopProcess(gateway.child);
    await stopProcess(proxy.child);
    await closeServer(mock);
  }
}

async function benchmarkReal(proxyBinary) {
  const root = join(benchmarkRoot, "real");
  const ports = await freePorts(3);
  const config = benchmarkConfig(root, ports);
  config.runtimeDir = runtimeDir;
  const { key } = ensureState(config);
  const imported = syncLocalCodexAuth(config);
  if (!imported.available) {
    throw new Error("Real benchmark requires an existing local Codex ChatGPT login");
  }
  const alias = gatewayAliasForModel(options.model);
  syncProxyAliases(config, [{ id: options.model, isDefault: true }]);

  const proxy = await startProxy(proxyBinary, config, key);
  await waitForProxyModel(config, key, alias);
  const gateway = await startGateway(config, key, config.proxyBaseUrl);
  try {
    await drainUsage(config, key);
    const direct = [];
    for (let index = 0; index < options.realRuns; index++) {
      const gatewaySample = await runGatewayRequest(config, key, {
        model: alias,
        selectedModel: alias,
        payloadBytes: 0,
        traceId: `real-direct-${index}-${Date.now()}`,
      });
      const usage = await waitForUsage(config, key, 20_000);
      direct.push(addProxyUsage(gatewaySample, usage));
    }

    const native = [];
    for (let index = 0; index < options.realRuns; index++) {
      native.push(await runNativeCodex(options.model));
    }

    const claudeBare = [];
    const claudeFull = [];
    const claudeDefaultEffort = [];
    const claudeDefaultEffortNoBackground = [];
    for (let index = 0; index < options.realRuns; index++) {
      await drainUsage(config, key);
      claudeBare.push(await runClaudeCode(config, key, alias, { bare: true, effort: "medium" }));
      await drainUsage(config, key);
      claudeFull.push(await runClaudeCode(config, key, alias, { bare: false, effort: "medium" }));
      await drainUsage(config, key);
      claudeDefaultEffort.push(await runClaudeCode(config, key, alias, {
        bare: false,
        effort: null,
        disableNonessential: false,
      }));
      await drainUsage(config, key);
      claudeDefaultEffortNoBackground.push(await runClaudeCode(config, key, alias, {
        bare: false,
        effort: null,
        disableNonessential: true,
      }));
    }

    return {
      description: "Bounded real subscription requests. Direct bridge and native use the same model, medium reasoning effort, and standard service tier.",
      model: options.model,
      reasoning_effort: "medium",
      service_tier: "default",
      proxy_startup_ms: proxy.startupMs,
      gateway_startup_ms: gateway.startupMs,
      direct_bridge: summarizeTranslatedSamples(direct),
      native_codex_exec: summarizeNativeSamples(native),
      claude_code_bare_bridge: summarizeClaudeSamples(claudeBare),
      claude_code_full_harness_medium_bridge: summarizeClaudeSamples(claudeFull),
      claude_code_full_harness_default_effort_bridge:
        summarizeClaudeSamples(claudeDefaultEffort),
      claude_code_full_harness_default_effort_no_background_bridge:
        summarizeClaudeSamples(claudeDefaultEffortNoBackground),
    };
  } finally {
    await stopProcess(gateway.child);
    await stopProcess(proxy.child);
  }
}

async function runGatewayRequest(config, key, {
  model,
  selectedModel = null,
  payloadBytes,
  traceId,
}) {
  const payload = buildAnthropicPayload(model, payloadBytes);
  const started = process.hrtime.bigint();
  const headers = {
    Authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    [TRACE_ID_HEADER]: traceId,
  };
  if (selectedModel) headers["x-claude-codex-model"] = selectedModel;
  const response = await fetch(`${config.gatewayBaseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: payload,
    signal: AbortSignal.timeout(120_000),
  });
  const headersAt = process.hrtime.bigint();
  const reader = response.body.getReader();
  let firstByteAt = null;
  let responseBytes = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!firstByteAt) firstByteAt = process.hrtime.bigint();
    responseBytes += value.length;
    if (!response.ok && chunks.length < 8) chunks.push(value);
  }
  const ended = process.hrtime.bigint();
  if (!response.ok) {
    const errorText = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
    throw new Error(`Gateway returned HTTP ${response.status}: ${safeText(errorText)}`);
  }
  const trace = await waitForTrace(config.tracePath, traceId);
  return {
    trace_id: traceId,
    request_bytes: Buffer.byteLength(payload),
    response_bytes: responseBytes,
    client_headers_ms: elapsedMs(started, headersAt),
    client_ttft_ms: firstByteAt ? elapsedMs(started, firstByteAt) : null,
    client_total_ms: elapsedMs(started, ended),
    gateway: trace,
  };
}

async function runNativeCodex(model) {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--model",
    model,
    "--config",
    'model_reasoning_effort="medium"',
    "--config",
    'service_tier="default"',
    "--cd",
    process.cwd(),
    "Reply with exactly OK. Do not use tools.",
  ];
  const result = await runJsonlProcess("codex", args, {
    eventType(record) {
      return typeof record?.type === "string" ? record.type : null;
    },
    firstModelEvent(record) {
      return record?.type === "item.started" || record?.type === "item.completed";
    },
    firstAssistantEvent(record) {
      return record?.type === "item.completed" &&
        ["agent_message", "assistant_message"].includes(record?.item?.type);
    },
    timeoutMs: 120_000,
  });
  return result;
}

async function runClaudeCode(
  config,
  key,
  alias,
  { bare, effort, disableNonessential = false },
) {
  const settingsPath = join(config.stateDir, "benchmark-claude-settings.json");
  const settings = renderClaudeCodexSettings(config, alias, [alias]);
  settings.env.ANTHROPIC_API_KEY = key;
  settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = disableNonessential ? "1" : "";
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  const beforeRecords = readTraceRecords(config.tracePath).length;
  const modeArgs = bare ? ["--bare", "--tools", ""] : ["--safe-mode"];
  const args = [
    "--print",
    ...modeArgs,
    "--settings",
    settingsPath,
    "--model",
    alias,
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "Reply with exactly OK. Do not use tools.",
  ];
  if (effort) args.splice(args.indexOf("--no-session-persistence"), 0, "--effort", effort);
  const processMetrics = await runJsonlProcess("claude", args, {
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: key,
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_BASE_URL: config.gatewayBaseUrl,
      ANTHROPIC_CUSTOM_HEADERS: `x-claude-codex-model: ${alias}`,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: disableNonessential ? "1" : "",
    },
    eventType(record) {
      if (record?.type === "stream_event") return `stream_event:${record?.event?.type ?? "unknown"}`;
      return typeof record?.type === "string" ? record.type : null;
    },
    firstModelEvent(record) {
      return record?.type === "stream_event";
    },
    firstAssistantEvent(record) {
      return record?.type === "stream_event" &&
        record?.event?.type === "content_block_delta" &&
        typeof record?.event?.delta?.text === "string";
    },
    timeoutMs: 120_000,
  });

  const gatewayRequests = await waitForNewGatewayRequests(config.tracePath, beforeRecords, alias);
  const usageRecords = await collectUsage(config, key, 2_000);
  const primaryGateway = [...gatewayRequests].sort(
    (left, right) => (right.request_bytes ?? 0) - (left.request_bytes ?? 0),
  )[0] ?? null;
  const primaryUsage = [...usageRecords].sort(
    (left, right) => (right.tokens?.input_tokens ?? 0) - (left.tokens?.input_tokens ?? 0),
  )[0] ?? null;
  return {
    ...processMetrics,
    gateway_request_count: gatewayRequests.length,
    gateway_total_request_bytes: gatewayRequests.reduce(
      (sum, request) => sum + (request.request_bytes ?? 0),
      0,
    ),
    proxy_attempt_count: usageRecords.length,
    proxy_failed_attempt_count: usageRecords.filter((usage) => usage.failed).length,
    proxy_distinct_request_ids: new Set(
      usageRecords.map((usage) => usage.request_id).filter(Boolean),
    ).size,
    proxy_total_input_tokens: usageRecords.reduce(
      (sum, usage) => sum + (usage.tokens?.input_tokens ?? 0),
      0,
    ),
    proxy_reasoning_efforts: unique(usageRecords.map((usage) => usage.reasoning_effort)),
    gateway: primaryGateway,
    proxy_usage: primaryUsage,
  };
}

async function runJsonlProcess(command, args, {
  env = process.env,
  eventType,
  firstModelEvent,
  firstAssistantEvent,
  timeoutMs,
}) {
  const started = process.hrtime.bigint();
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdoutBuffer = "";
  let stderr = "";
  const eventTypes = [];
  let firstEventAt = null;
  let firstModelAt = null;
  let firstAssistantAt = null;
  child.stdout.on("data", (chunk) => {
    const receivedAt = process.hrtime.bigint();
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!firstEventAt) firstEventAt = receivedAt;
      const type = eventType(record);
      if (type && !eventTypes.includes(type)) eventTypes.push(type);
      if (!firstModelAt && firstModelEvent(record)) firstModelAt = receivedAt;
      if (!firstAssistantAt && firstAssistantEvent(record)) firstAssistantAt = receivedAt;
    }
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 16_000) stderr += chunk.toString("utf8");
  });
  const exit = await waitForExit(child, timeoutMs);
  children.delete(child);
  const ended = process.hrtime.bigint();
  if (exit.code !== 0) {
    throw new Error(`${command} exited with ${exit.code}: ${safeText(stderr)}`);
  }
  return {
    first_json_event_ms: firstEventAt ? elapsedMs(started, firstEventAt) : null,
    first_model_event_ms: firstModelAt ? elapsedMs(started, firstModelAt) : null,
    first_assistant_output_ms: firstAssistantAt ? elapsedMs(started, firstAssistantAt) : null,
    total_ms: elapsedMs(started, ended),
    event_types: eventTypes,
  };
}

function createMockAnthropicServer() {
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Body consumption is part of the deterministic upstream boundary.
    }
    await delay(options.mockHeaderDelayMs);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    await delay(options.mockFirstByteDelayMs);
    response.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock","type":"message","role":"assistant","content":[],"model":"mock","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
    await delay(options.mockStreamDelayMs);
    response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  return server;
}

function createMockCodexServer(model) {
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume the translated Codex payload before starting upstream timing.
    }
    await delay(options.mockHeaderDelayMs);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    await delay(options.mockFirstByteDelayMs);
    response.write(sse({
      type: "response.created",
      response: { id: "resp_mock", object: "response", status: "in_progress", model, output: [] },
    }));
    await delay(options.mockStreamDelayMs);
    response.write(sse({
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" },
    }));
    response.write(sse({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "OK",
    }));
    response.write(sse({
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "OK" },
    }));
    response.end(sse({
      type: "response.completed",
      response: {
        id: "resp_mock",
        object: "response",
        status: "completed",
        model,
        output: [{
          id: "msg_mock",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "OK" }],
        }],
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      },
    }));
  });
  return server;
}

function renderMockProxyConfig(config, key, upstreamUrl, rawModel, alias) {
  return [
    renderProxyConfig(config, key).trimEnd(),
    "codex-api-key:",
    `  - api-key: ${JSON.stringify("benchmark-upstream-key")}`,
    `    base-url: ${JSON.stringify(upstreamUrl)}`,
    "    models:",
    `      - name: ${JSON.stringify(rawModel)}`,
    `        alias: ${JSON.stringify(alias)}`,
    "",
  ].join("\n");
}

async function startProxy(binary, config, key) {
  const started = process.hrtime.bigint();
  const child = spawn(binary, ["-config", config.proxyConfigPath], {
    cwd: ROOT,
    env: { ...process.env, MANAGEMENT_PASSWORD: key },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const output = collectOutput(child);
  await waitForHttp(`${config.proxyBaseUrl}/`, {}, output, 15_000);
  return { child, startupMs: elapsedMs(started, process.hrtime.bigint()), output };
}

async function startGateway(config, _key, proxyBaseUrl) {
  const started = process.hrtime.bigint();
  const child = spawn(
    process.execPath,
    [join(ROOT, "lib", "gateway.mjs"), "--port", String(config.gatewayPort)],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CLAUDE_CODEX_GATEWAY_PORT: String(config.gatewayPort),
        CLAUDE_CODEX_PROXY_BASE_URL: proxyBaseUrl,
        CLAUDE_CODEX_PROXY_KEY_PATH: config.proxyKeyPath,
        CLAUDE_CODEX_STATE_DIR: config.stateDir,
        CLAUDE_CODEX_TRACE: "1",
        CLAUDE_CODEX_TRACE_PATH: config.tracePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  const output = collectOutput(child);
  await waitForHttp(`${config.gatewayBaseUrl}/healthz`, {}, output, 5_000);
  return { child, startupMs: elapsedMs(started, process.hrtime.bigint()), output };
}

async function waitForHttp(url, init, output, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Process startup is still in progress.
    }
    await delay(50);
  }
  throw new Error(`Service did not become ready at ${url}: ${safeText(output())}`);
}

async function waitForProxyModel(config, key, model, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastModels = [];
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${config.proxyBaseUrl}/v1/models`, {
        headers: {
          Authorization: `Bearer ${key}`,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const payload = await response.json();
        lastModels = (payload?.data ?? []).map((entry) => entry?.id).filter(Boolean);
        if (lastModels.includes(model)) return;
      }
    } catch {
      // Auth and model watchers may still be loading their first snapshot.
    }
    await delay(50);
  }
  throw new Error(
    `CLIProxy did not publish ${model}; available models: ${lastModels.slice(0, 20).join(", ")}`,
  );
}

async function waitForTrace(path, traceId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = readTraceRecords(path).find(
      (entry) => entry.trace_id === traceId && entry.event === "request_complete",
    );
    if (record) return record;
    await delay(10);
  }
  throw new Error(`Timed out waiting for gateway trace ${traceId}`);
}

async function waitForUsage(config, key, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const records = await popProxyUsageRecords(config.proxyBaseUrl, key, 100);
    if (records.length) return records.at(-1);
    await delay(20);
  }
  throw new Error("Timed out waiting for CLIProxy usage timing record");
}

async function collectUsage(config, key, waitMs) {
  const records = [];
  const deadline = Date.now() + waitMs;
  let lastRecordAt = Date.now();
  while (Date.now() < deadline) {
    const batch = await popProxyUsageRecords(config.proxyBaseUrl, key, 100);
    if (batch.length) {
      records.push(...batch);
      lastRecordAt = Date.now();
    } else if (records.length && Date.now() - lastRecordAt >= 150) {
      break;
    }
    await delay(25);
  }
  return records;
}

async function drainUsage(config, key) {
  for (;;) {
    const records = await popProxyUsageRecords(config.proxyBaseUrl, key, 100);
    if (!records.length) return;
  }
}

async function waitForNewGatewayRequests(path, initialLength, model, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const records = readTraceRecords(path).slice(initialLength);
    const complete = records.filter(
      (record) => record.event === "request_complete" && (!model || record.model === model),
    );
    if (complete.length) return complete;
    await delay(20);
  }
  return readTraceRecords(path).slice(initialLength).filter(
    (record) => record.event === "request_complete",
  );
}

function addProxyUsage(sample, usage) {
  return {
    ...sample,
    proxy_usage: usage,
    derived: {
      local_bridge_ttft_ms: difference(sample.gateway.gateway_ttft_ms, usage.ttft_ms),
      outside_proxy_executor_total_ms: difference(sample.gateway.total_ms, usage.latency_ms),
    },
  };
}

function summarizeGatewaySamples(samples, expected) {
  return {
    samples: samples.length,
    actual_request_bytes: stats(samples.map((sample) => sample.request_bytes)),
    client_headers_ms: stats(samples.map((sample) => sample.client_headers_ms)),
    client_ttft_ms: stats(samples.map((sample) => sample.client_ttft_ms)),
    client_total_ms: stats(samples.map((sample) => sample.client_total_ms)),
    body_read_ms: stats(samples.map((sample) => sample.gateway.body_read_ms)),
    prepare_ms: stats(samples.map((sample) => sample.gateway.prepare_ms)),
    proxy_wait_headers_ms: stats(samples.map((sample) => sample.gateway.proxy_wait_headers_ms)),
    gateway_ttft_ms: stats(samples.map((sample) => sample.gateway.gateway_ttft_ms)),
    relay_ms: stats(samples.map((sample) => sample.gateway.relay_ms)),
    stream_ms: stats(samples.map((sample) => sample.gateway.stream_ms)),
    gateway_total_ms: stats(samples.map((sample) => sample.gateway.total_ms)),
    local_overhead_ttft_ms: stats(samples.map(
      (sample) => sample.gateway.gateway_ttft_ms - expected.expectedTtftMs,
    )),
    local_overhead_total_ms: stats(samples.map(
      (sample) => sample.gateway.total_ms - expected.expectedTotalMs,
    )),
  };
}

function summarizeTranslatedSamples(samples) {
  return {
    samples: samples.length,
    actual_request_bytes: stats(samples.map((sample) => sample.request_bytes)),
    client_ttft_ms: stats(samples.map((sample) => sample.client_ttft_ms)),
    client_total_ms: stats(samples.map((sample) => sample.client_total_ms)),
    gateway_body_read_ms: stats(samples.map((sample) => sample.gateway.body_read_ms)),
    gateway_prepare_ms: stats(samples.map((sample) => sample.gateway.prepare_ms)),
    gateway_ttft_ms: stats(samples.map((sample) => sample.gateway.gateway_ttft_ms)),
    gateway_total_ms: stats(samples.map((sample) => sample.gateway.total_ms)),
    codex_transport_ttft_ms: stats(samples.map((sample) => sample.proxy_usage.ttft_ms)),
    proxy_executor_total_ms: stats(samples.map((sample) => sample.proxy_usage.latency_ms)),
    local_bridge_ttft_ms: stats(samples.map((sample) => sample.derived.local_bridge_ttft_ms)),
    outside_proxy_executor_total_ms: stats(samples.map(
      (sample) => sample.derived.outside_proxy_executor_total_ms,
    )),
    input_tokens: stats(samples.map((sample) => sample.proxy_usage.tokens?.input_tokens)),
    output_tokens: stats(samples.map((sample) => sample.proxy_usage.tokens?.output_tokens)),
    reasoning_efforts: unique(samples.map((sample) => sample.proxy_usage.reasoning_effort)),
    request_service_tiers: unique(samples.map(
      (sample) => sample.proxy_usage.request_service_tier,
    )),
  };
}

function summarizeNativeSamples(samples) {
  return {
    samples: samples.length,
    first_json_event_ms: stats(samples.map((sample) => sample.first_json_event_ms)),
    first_model_event_ms: stats(samples.map((sample) => sample.first_model_event_ms)),
    first_assistant_output_ms: stats(samples.map((sample) => sample.first_assistant_output_ms)),
    total_ms: stats(samples.map((sample) => sample.total_ms)),
    event_types: unique(samples.flatMap((sample) => sample.event_types)),
  };
}

function summarizeClaudeSamples(samples) {
  return {
    samples: samples.length,
    first_json_event_ms: stats(samples.map((sample) => sample.first_json_event_ms)),
    first_model_event_ms: stats(samples.map((sample) => sample.first_model_event_ms)),
    first_assistant_output_ms: stats(samples.map((sample) => sample.first_assistant_output_ms)),
    process_total_ms: stats(samples.map((sample) => sample.total_ms)),
    gateway_request_count: stats(samples.map((sample) => sample.gateway_request_count)),
    proxy_attempt_count: stats(samples.map((sample) => sample.proxy_attempt_count)),
    proxy_failed_attempt_count: stats(samples.map(
      (sample) => sample.proxy_failed_attempt_count,
    )),
    proxy_distinct_request_ids: stats(samples.map(
      (sample) => sample.proxy_distinct_request_ids,
    )),
    gateway_total_request_bytes: stats(samples.map(
      (sample) => sample.gateway_total_request_bytes,
    )),
    proxy_total_input_tokens: stats(samples.map((sample) => sample.proxy_total_input_tokens)),
    gateway_request_bytes: stats(samples.map((sample) => sample.gateway?.request_bytes)),
    gateway_ttft_ms: stats(samples.map((sample) => sample.gateway?.gateway_ttft_ms)),
    gateway_total_ms: stats(samples.map((sample) => sample.gateway?.total_ms)),
    codex_transport_ttft_ms: stats(samples.map((sample) => sample.proxy_usage?.ttft_ms)),
    proxy_executor_total_ms: stats(samples.map((sample) => sample.proxy_usage?.latency_ms)),
    input_tokens: stats(samples.map((sample) => sample.proxy_usage?.tokens?.input_tokens)),
    reasoning_efforts: unique(samples.map((sample) => sample.proxy_usage?.reasoning_effort)),
    all_reasoning_efforts: unique(samples.flatMap(
      (sample) => sample.proxy_reasoning_efforts,
    )),
    event_types: unique(samples.flatMap((sample) => sample.event_types)),
  };
}

function buildAnthropicPayload(model, requestedPayloadBytes) {
  const base = {
    model,
    max_tokens: 16,
    stream: true,
    messages: [{ role: "user", content: "Reply with exactly OK. Do not use tools." }],
  };
  if (requestedPayloadBytes > 0) {
    base.system = [{ type: "text", text: "x".repeat(requestedPayloadBytes) }];
  }
  return JSON.stringify(base);
}

function benchmarkConfig(root, [gatewayPort, proxyPort, appServerPort]) {
  return getConfig({
    stateDir: root,
    runtimeDir,
    codexHome: process.env.CODEX_HOME ?? join(process.env.HOME, ".codex"),
    claudeUserSettingsPath: join(root, "claude-settings.json"),
    zshrcPath: join(root, ".zshrc"),
    gatewayPort,
    proxyPort,
    appServerPort,
    traceEnabled: true,
    tracePath: join(root, "logs", "request-trace.jsonl"),
  });
}

async function freePorts(count) {
  const reservations = [];
  const ports = [];
  try {
    for (let index = 0; index < count; index++) {
      const server = http.createServer();
      await new Promise((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(0, "127.0.0.1", resolvePromise);
      });
      reservations.push(server);
      ports.push(server.address().port);
    }
  } finally {
    for (const server of reservations) await closeServer(server);
  }
  return ports;
}

async function listen(server) {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  servers.add(server);
  return server.address().port;
}

async function closeServer(server) {
  servers.delete(server);
  if (!server.listening) return;
  await new Promise((resolvePromise) => server.close(resolvePromise));
}

function collectOutput(child) {
  let output = "";
  const collect = (chunk) => {
    if (output.length < 32_000) output += chunk.toString("utf8");
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return () => output;
}

async function stopProcess(child) {
  children.delete(child);
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    new Promise((resolvePromise) => child.once("exit", () => resolvePromise(true))),
    delay(2_000).then(() => false),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function waitForExit(child, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      new Promise((resolvePromise, rejectPromise) => {
        child.once("error", rejectPromise);
        child.once("exit", (code, signal) => resolvePromise({ code, signal }));
      }),
      new Promise((_, rejectPromise) => {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          rejectPromise(new Error(`Timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cleanup() {
  for (const child of [...children]) await stopProcess(child);
  for (const server of [...servers]) await closeServer(server);
}

function parseOptions(args) {
  const value = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const integer = (name, fallback, minimum, maximum) => {
    const parsed = Number(value(name, fallback));
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
    }
    return parsed;
  };
  const output = value("--output", null);
  return {
    real: args.includes("--real"),
    model: value("--model", configuredCodexModel()),
    runs: integer("--runs", 5, 1, 50),
    realRuns: integer("--real-runs", 2, 1, 5),
    mockHeaderDelayMs: integer("--mock-header-delay", 5, 0, 1_000),
    mockFirstByteDelayMs: integer("--mock-first-byte-delay", 10, 0, 1_000),
    mockStreamDelayMs: integer("--mock-stream-delay", 5, 0, 1_000),
    payloadBytes: [1_024, 102_400, 1_048_576],
    output: output ? resolve(output) : null,
  };
}

function configuredCodexModel() {
  try {
    const config = readFileSync(join(process.env.CODEX_HOME ?? join(process.env.HOME, ".codex"), "config.toml"), "utf8");
    return config.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? "gpt-5.4";
  } catch {
    return "gpt-5.4";
  }
}

function commandVersion(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function stats(values) {
  const numbers = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (!numbers.length) return null;
  numbers.sort((left, right) => left - right);
  return {
    n: numbers.length,
    min: round(numbers[0]),
    p50: round(percentile(numbers, 0.5)),
    p95: round(percentile(numbers, 0.95)),
    max: round(numbers.at(-1)),
    mean: round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length),
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined))];
}

function difference(left, right) {
  return typeof left === "number" && typeof right === "number" ? left - right : null;
}

function elapsedMs(start, end) {
  return Number((end - start) / 1_000n) / 1_000;
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function safeText(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted-api-key]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]")
    .trim()
    .slice(-4_000);
}

function progress(message) {
  process.stderr.write(`[cc-codex benchmark] ${message}\n`);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
