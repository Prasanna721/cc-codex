import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const TRACE_ID_HEADER = "x-cc-codex-trace-id";
export const TRACE_SCHEMA = "cc-codex.request-trace.v1";

const VALID_TRACE_ID = /^[a-zA-Z0-9._-]{8,128}$/;
const SENSITIVE_FIELD = /^(?:authorization|cookie|set-cookie|api[-_]?key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|secret|credential|request[-_]?body|response[-_]?body)$/i;

export function traceModeEnabled(value = process.env.CLAUDE_CODEX_TRACE) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export function traceIdFromHeader(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  const normalized = String(candidate ?? "").trim();
  return VALID_TRACE_ID.test(normalized) ? normalized : randomUUID();
}

export function createRequestTrace({
  enabled = traceModeEnabled(),
  path,
  traceId,
  component = "gateway",
} = {}) {
  const id = traceIdFromHeader(traceId);
  const startedNs = process.hrtime.bigint();
  const tracePath = path ? resolve(path) : null;
  let sequence = 0;

  if (enabled && !tracePath) {
    throw new Error("A trace path is required when CC Codex request tracing is enabled");
  }
  if (enabled) mkdirSync(dirname(tracePath), { recursive: true, mode: 0o700 });

  return {
    id,
    enabled,
    path: tracePath,
    startedNs,
    now() {
      return process.hrtime.bigint();
    },
    since(start = startedNs, end = process.hrtime.bigint()) {
      return durationMs(start, end);
    },
    event(event, details = {}) {
      if (!enabled) return;
      const atNs = process.hrtime.bigint();
      const record = {
        schema: TRACE_SCHEMA,
        timestamp: new Date().toISOString(),
        trace_id: id,
        sequence: ++sequence,
        component,
        event: String(event),
        elapsed_ms: durationMs(startedNs, atNs),
        ...sanitizeTraceDetails(details),
      };
      appendFileSync(tracePath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        flag: "a",
        mode: 0o600,
      });
    },
  };
}

export function readTraceRecords(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.schema === TRACE_SCHEMA && typeof record.trace_id === "string") {
        records.push(record);
      }
    } catch {
      // A partially written final line must not hide earlier complete traces.
    }
  }
  return records;
}

export async function popProxyUsageRecords(baseUrl, managementKey, count = 100) {
  if (!Number.isInteger(count) || count < 1 || count > 1_000) {
    throw new Error(`Invalid proxy usage record count: ${count}`);
  }
  const url = new URL(`/v0/management/usage-queue?count=${count}`, baseUrl);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${managementKey}` },
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`CLIProxy usage queue returned HTTP ${response.status}: ${redactString(text)}`);
  }
  const records = JSON.parse(text);
  if (!Array.isArray(records)) throw new Error("CLIProxy usage queue did not return an array");
  return records.map(sanitizeProxyUsageRecord);
}

function sanitizeProxyUsageRecord(record) {
  return {
    timestamp: stringOrNull(record?.timestamp),
    provider: stringOrNull(record?.provider),
    executor_type: stringOrNull(record?.executor_type),
    model: stringOrNull(record?.model),
    alias: stringOrNull(record?.alias),
    endpoint: stringOrNull(record?.endpoint),
    auth_type: stringOrNull(record?.auth_type),
    request_id: stringOrNull(record?.request_id),
    reasoning_effort: stringOrNull(record?.reasoning_effort),
    request_service_tier: stringOrNull(record?.request_service_tier),
    response_service_tier: stringOrNull(record?.response_service_tier),
    latency_ms: finiteNumber(record?.latency_ms),
    ttft_ms: finiteNumber(record?.ttft_ms),
    failed: record?.failed === true,
    status_code: finiteNumber(record?.fail?.status_code),
    tokens: sanitizeTokenCounts(record?.tokens),
  };
}

function sanitizeTokenCounts(tokens) {
  const result = {};
  for (const name of [
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cached_tokens",
    "cache_read_tokens",
    "cache_creation_tokens",
    "total_tokens",
  ]) {
    result[name] = finiteNumber(tokens?.[name]);
  }
  return result;
}

function sanitizeTraceDetails(details) {
  const result = {};
  if (!details || typeof details !== "object" || Array.isArray(details)) return result;
  for (const [key, value] of Object.entries(details)) {
    result[key] = SENSITIVE_FIELD.test(key) ? "[redacted]" : sanitizeValue(value);
  }
  return result;
}

function sanitizeValue(value) {
  if (typeof value === "string") return redactString(value).slice(0, 1_000);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(sanitizeValue);
  if (value && typeof value === "object") return sanitizeTraceDetails(value);
  return null;
}

function redactString(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted-api-key]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]");
}

function durationMs(start, end) {
  return Number(((end - start) / 1_000n)) / 1_000;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
