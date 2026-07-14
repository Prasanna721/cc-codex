import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const FAST_SERVICE_TIER = "priority";
export const FAST_REQUEST_HEADER = "x-cc-codex-fast";
export const SESSION_REQUEST_HEADER = "x-cc-codex-session";

export function modelSupportsFast(model) {
  return Array.isArray(model?.serviceTiers) && model.serviceTiers.some(
    (tier) => tier?.id === FAST_SERVICE_TIER,
  );
}

export function fastModelIds(models) {
  const ids = new Set();
  for (const model of models ?? []) {
    if (!modelSupportsFast(model)) continue;
    if (typeof model.id === "string") ids.add(model.id);
    if (typeof model.model === "string") ids.add(model.model);
    if (typeof model.proxy?.id === "string") ids.add(model.proxy.id);
  }
  return [...ids];
}

export function recordSupportsFast(record, modelId = record?.selectedModelId) {
  return Array.isArray(record?.fastModelIds) && record.fastModelIds.includes(modelId);
}

export function recordUsesFast(record, modelId = record?.selectedModelId) {
  return record?.fastMode === true && recordSupportsFast(record, modelId);
}

export function applySessionRoutingHeaders(headers, stateDir, { modelId = null } = {}) {
  const next = { ...headers };
  const sessionId = firstHeaderValue(next[SESSION_REQUEST_HEADER]);
  delete next[SESSION_REQUEST_HEADER];
  delete next[FAST_REQUEST_HEADER];

  if (!stateDir || !modelId || !validSessionId(sessionId)) return next;
  const record = readJson(resolve(stateDir, "session-modes", `${sessionId}.json`));
  if (recordUsesFast(record, modelId)) next[FAST_REQUEST_HEADER] = "1";
  return next;
}

function firstHeaderValue(value) {
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

function validSessionId(value) {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(value ?? ""));
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
