#!/usr/bin/env node

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";

const configPath = argumentValue("-config");
if (!configPath) throw new Error("fake CLIProxyAPI requires -config");

const config = readFileSync(configPath, "utf8");
const port = Number(config.match(/^port:\s*(\d+)\s*$/m)?.[1]);
const keyLine = config.match(/^api-keys:\s*\n\s*-\s*(.+)\s*$/m)?.[1];
const key = keyLine ? JSON.parse(keyLine) : null;
if (!Number.isInteger(port) || !key) throw new Error("fake CLIProxyAPI received invalid config");

const stateDir = dirname(configPath);
const startCountPath = join(stateDir, "test-proxy-start-count");
const rejectOncePath = join(stateDir, "test-reject-second-model-request");
const rejectAlwaysPath = join(stateDir, "test-always-reject-second-model-request");
const starts = Number(readText(startCountPath) || 0) + 1;
writeFileSync(startCountPath, String(starts));

let authorizedModelRequests = 0;
const server = http.createServer((request, response) => {
  if (request.url === "/healthz") return json(response, 200, { status: "ok" });
  if (request.url === "/") return json(response, 200, { message: "CLI Proxy API Server" });
  if (request.url?.startsWith("/v1/models")) {
    if (request.headers.authorization !== `Bearer ${key}`) {
      return json(response, 401, { error: "Invalid API key" });
    }
    authorizedModelRequests += 1;
    if (
      authorizedModelRequests === 2 &&
      (existsSync(rejectOncePath) || existsSync(rejectAlwaysPath))
    ) {
      if (existsSync(rejectOncePath)) rmSync(rejectOncePath, { force: true });
      return json(response, 401, { error: "Invalid API key" });
    }
    return json(response, 200, {
      data: [{ id: "claude-codex-dGVzdA", display_name: "Test Codex" }],
    });
  }
  return json(response, 404, { error: "not found" });
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readText(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
