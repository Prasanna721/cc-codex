import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import {
  FAST_REQUEST_HEADER,
  SESSION_REQUEST_HEADER,
} from "./fast.mjs";
import { traceModeEnabled } from "./trace.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CONTROLLER_VERSION = "0.9.3";

export const CLIPROXY_PIN = Object.freeze({
  version: "7.2.71",
  tag: "v7.2.71",
  commit: "5b7f2361",
  repository: "https://github.com/router-for-me/CLIProxyAPI",
  assets: {
    "darwin-arm64": {
      name: "CLIProxyAPI_7.2.71_darwin_aarch64.tar.gz",
      sha256: "f8cd1028c591bcb89fdb15650457ae6a56e462346d7cf108a9f02dcb819196dd",
    },
    "darwin-x64": {
      name: "CLIProxyAPI_7.2.71_darwin_amd64.tar.gz",
      sha256: "1b8d4a969c952397764188e53d0b23249f484cb62043c83a534cfaea7d7d5ab0",
    },
    "linux-arm64": {
      name: "CLIProxyAPI_7.2.71_linux_aarch64.tar.gz",
      sha256: "fa49b1a0d1b88bab65558299156a35cac9025ff0bf73fbfc95ecf2644d393488",
    },
    "linux-x64": {
      name: "CLIProxyAPI_7.2.71_linux_amd64.tar.gz",
      sha256: "3201240a435c073acd77a7178c658838d750a57e79254b3850db81d8eb90b500",
    },
  },
});

export const CLAUDE_MODEL_PREFIX = "claude-fable-5-dd-";
export const GATEWAY_MODEL_PREFIX = "claude-codex-";

const serviceCoordinationContext = new AsyncLocalStorage();

export const CLAUDE_PROVIDER_ENV_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
]);

const CLAUDE_AUXILIARY_MODEL_IDS = Object.freeze([
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
]);

export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserError";
  }
}

export function getConfig(overrides = {}) {
  const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA || null;
  const configuredStateDir =
    overrides.stateDir ?? pluginDataDir ?? process.env.CLAUDE_CODEX_STATE_DIR;
  if (!configuredStateDir) {
    throw new UserError(
      "CC Codex must run as a Claude Code plugin so CLAUDE_PLUGIN_DATA is available.",
    );
  }
  const stateDir = resolve(configuredStateDir);
  const runtimeDir = resolve(
    overrides.runtimeDir ?? process.env.CLAUDE_CODEX_RUNTIME_DIR ?? join(stateDir, "runtime"),
  );
  const proxyPort = numberFrom(
    overrides.proxyPort ?? process.env.CLAUDE_CODEX_PROXY_PORT,
    18317,
  );
  const gatewayPort = numberFrom(
    overrides.gatewayPort ?? process.env.CLAUDE_CODEX_GATEWAY_PORT,
    18316,
  );
  const appServerPort = numberFrom(
    overrides.appServerPort ?? process.env.CLAUDE_CODEX_APP_SERVER_PORT,
    18318,
  );
  const claudeUserSettingsPath = resolve(
    overrides.claudeUserSettingsPath ?? overrides.claudeSettingsPath ??
      process.env.CLAUDE_CODEX_CLAUDE_SETTINGS_PATH ??
      join(homedir(), ".claude", "settings.json"),
  );
  const zshrcPath = resolve(
    overrides.zshrcPath ?? process.env.CLAUDE_CODEX_ZSHRC_PATH ??
      join(homedir(), ".zshrc"),
  );
  const codexHome = resolve(
    overrides.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  );
  const logsDir = join(stateDir, "logs");
  const traceEnabled = traceModeEnabled(
    overrides.traceEnabled ?? process.env.CLAUDE_CODEX_TRACE,
  );
  const tracePath = resolve(
    overrides.tracePath ?? process.env.CLAUDE_CODEX_TRACE_PATH ??
      join(logsDir, "request-trace.jsonl"),
  );
  const hostLocksDir = resolve(
    overrides.hostLocksDir ?? process.env.CLAUDE_CODEX_HOST_LOCKS_DIR ??
      join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "cc-codex", "locks"),
  );

  return {
    root: ROOT,
    stateDir,
    runtimeDir,
    gatewayPort,
    proxyPort,
    appServerPort,
    gatewayBaseUrl: `http://127.0.0.1:${gatewayPort}`,
    proxyBaseUrl: `http://127.0.0.1:${proxyPort}`,
    appServerHttpUrl: `http://127.0.0.1:${appServerPort}`,
    appServerWsUrl: `ws://127.0.0.1:${appServerPort}`,
    authDir: join(stateDir, "cliproxy-auth"),
    codexHome,
    localCodexAuthPath: resolve(overrides.localCodexAuthPath ?? join(codexHome, "auth.json")),
    localProxyAuthPath: join(stateDir, "cliproxy-auth", "codex-local.json"),
    logsDir,
    locksDir: join(stateDir, "locks"),
    hostLocksDir,
    sessionsDir: join(stateDir, "sessions"),
    terminalRoutesDir: join(stateDir, "terminal-routes"),
    sessionModesDir: join(stateDir, "session-modes"),
    shellDir: join(stateDir, "shell"),
    shellIntegrationPath: join(stateDir, "shell", "cc-codex.zsh"),
    terminalLauncherPath: join(stateDir, "shell", "terminal-launcher.mjs"),
    terminalLauncherSourcePath: join(ROOT, "scripts", "terminal-launcher.mjs"),
    zshrcPath,
    zshrcBackupPath: join(stateDir, "shell", "zshrc.before-cc-codex"),
    legacyHandoffsDir: join(stateDir, "handoffs"),
    legacyResumeStatePath: join(stateDir, "resume-state.json"),
    legacyResumeHelperPath: resolve(
      overrides.legacyResumeHelperPath ?? overrides.resumeHelperPath ??
        process.env.CLAUDE_CODEX_RESUME_HELPER_PATH ??
        join(homedir(), ".local", "bin", "codex-mode"),
    ),
    legacyGlobalModeStatePath: join(stateDir, "persistent-mode.json"),
    claudeUserSettingsPath,
    gatewayPidPath: join(stateDir, "claude-gateway.pid.json"),
    proxyPidPath: join(stateDir, "cliproxy.pid.json"),
    appServerPidPath: join(stateDir, "codex-app-server.pid.json"),
    proxyKeyPath: join(stateDir, "proxy.key"),
    proxyConfigPath: join(stateDir, "cliproxyapi.yaml"),
    proxyAliasesPath: join(stateDir, "proxy-model-aliases.json"),
    traceEnabled,
    tracePath,
    pluginDir: ROOT,
  };
}

function numberFrom(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new UserError(`Invalid TCP port: ${value}`);
  }
  return parsed;
}

export function encodeClaudeModelId(model) {
  if (!model || model.startsWith("claude-") || model.startsWith("anthropic")) return model;
  return CLAUDE_MODEL_PREFIX + Array.from(model).reverse().join("");
}

export function decodeClaudeModelId(model) {
  if (!model?.startsWith(CLAUDE_MODEL_PREFIX)) return model;
  return Array.from(model.slice(CLAUDE_MODEL_PREFIX.length)).reverse().join("");
}

export function gatewayAliasForModel(model) {
  return `${GATEWAY_MODEL_PREFIX}${Buffer.from(model, "utf8").toString("base64url")}`;
}

export function decodeGatewayModelAlias(model) {
  if (!model?.startsWith(GATEWAY_MODEL_PREFIX)) return null;
  try {
    return Buffer.from(model.slice(GATEWAY_MODEL_PREFIX.length), "base64url").toString("utf8");
  } catch {
    return null;
  }
}

export function ensureState(config = getConfig()) {
  for (const dir of [
    config.stateDir,
    config.runtimeDir,
    config.authDir,
    config.logsDir,
    config.locksDir,
    config.sessionsDir,
    config.terminalRoutesDir,
    config.sessionModesDir,
    config.shellDir,
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  if (!existsSync(config.proxyKeyPath)) {
    writeAtomic(config.proxyKeyPath, `${randomBytes(32).toString("hex")}\n`, 0o600);
  }
  const key = readFileSync(config.proxyKeyPath, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(key)) {
    throw new UserError(`Invalid local proxy key in ${config.proxyKeyPath}`);
  }

  const yaml = renderProxyConfig(config, key, readProxyAliasRecords(config));
  if (!existsSync(config.proxyConfigPath) || readFileSync(config.proxyConfigPath, "utf8") !== yaml) {
    writeAtomic(config.proxyConfigPath, yaml, 0o600);
  }
  return { key };
}

export function syncLocalCodexAuth(config = getConfig()) {
  ensureState(config);
  const source = readJson(config.localCodexAuthPath);
  const tokens = source?.tokens;
  if (!source || !tokens) {
    return {
      available: false,
      imported: false,
      reason: "No local Codex ChatGPT login was found.",
    };
  }

  const accessToken = stringValue(tokens.access_token);
  const refreshToken = stringValue(tokens.refresh_token);
  const idToken = stringValue(tokens.id_token);
  const accountId = stringValue(tokens.account_id);
  if (!accessToken || !refreshToken || !idToken) {
    return {
      available: false,
      imported: false,
      reason: "The local Codex login is incomplete or uses a non-ChatGPT authentication method.",
    };
  }

  const claims = parseJwtPayload(idToken);
  const authClaims = claims?.["https://api.openai.com/auth"];
  const email = stringValue(claims?.email) || "local-codex";
  const planType = stringValue(authClaims?.chatgpt_plan_type) || null;
  const expiresAt = Number(claims?.exp);
  const record = {
    type: "codex",
    access_token: accessToken,
    refresh_token: refreshToken,
    id_token: idToken,
    account_id: accountId || stringValue(authClaims?.chatgpt_account_id),
    last_refresh: stringValue(source.last_refresh) || new Date().toISOString(),
    expired: Number.isFinite(expiresAt)
      ? new Date(expiresAt * 1000).toISOString()
      : "",
    email,
    disabled: false,
    source: "local-codex-cli",
  };
  if (planType) record.plan_type = planType;

  const existing = readJson(config.localProxyAuthPath);
  const sourceRefresh = Date.parse(record.last_refresh);
  const proxyRefresh = Date.parse(stringValue(existing?.last_refresh));
  if (
    existing?.type === "codex" &&
    Number.isFinite(proxyRefresh) &&
    (!Number.isFinite(sourceRefresh) || proxyRefresh > sourceRefresh)
  ) {
    return {
      available: true,
      imported: false,
      planType: stringValue(existing.plan_type) || planType,
    };
  }

  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  const current = existsSync(config.localProxyAuthPath)
    ? readFileSync(config.localProxyAuthPath, "utf8")
    : null;
  const imported = current !== serialized;
  if (imported) writeAtomic(config.localProxyAuthPath, serialized, 0o600);
  return { available: true, imported, planType };
}

function parseJwtPayload(token) {
  try {
    const payload = String(token).split(".")[1];
    return payload ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) : null;
  } catch {
    return null;
  }
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function buildClaudeCodexEnvironment(
  config,
  proxyModelId,
  baseEnvironment = process.env,
  { sessionId = null } = {},
) {
  const { key } = ensureState(config);
  const environment = { ...baseEnvironment };
  for (const name of CLAUDE_PROVIDER_ENV_KEYS) delete environment[name];

  const reservedHeaders = new Set([
    "authorization",
    "x-api-key",
    "x-claude-codex-model",
    FAST_REQUEST_HEADER,
    SESSION_REQUEST_HEADER,
  ]);
  const existingHeaders = String(baseEnvironment.ANTHROPIC_CUSTOM_HEADERS ?? "")
    .split("\n")
    .filter((line) => {
      const separator = line.indexOf(":");
      const name = separator >= 0 ? line.slice(0, separator).trim().toLowerCase() : "";
      return line.trim() && !reservedHeaders.has(name);
    });

  const routingHeaders = [`x-claude-codex-model: ${proxyModelId}`];
  if (sessionId) {
    validateSessionId(sessionId);
    routingHeaders.push(`${SESSION_REQUEST_HEADER}: ${sessionId}`);
  }

  Object.assign(environment, {
    ANTHROPIC_BASE_URL: config.gatewayBaseUrl,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_CUSTOM_HEADERS: [...routingHeaders, ...existingHeaders].join("\n"),
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    CLAUDE_CODE_SUBAGENT_MODEL: "inherit",
    CLAUDE_CODEX_ACTIVE: "1",
    CLAUDE_CODEX_ROOT: ROOT,
    CLAUDE_CODEX_STATE_DIR: config.stateDir,
    CLAUDE_CODEX_RUNTIME_DIR: config.runtimeDir,
    CLAUDE_CODEX_GATEWAY_PORT: String(config.gatewayPort),
    CLAUDE_CODEX_PROXY_PORT: String(config.proxyPort),
    CLAUDE_CODEX_APP_SERVER_PORT: String(config.appServerPort),
  });
  // Claude classifies gateway model discovery as nonessential traffic. Leaving
  // this flag enabled reduces /model to Default plus the current custom model.
  delete environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  return environment;
}

export function renderClaudeCodexSettings(
  config,
  proxyModelId,
  availableModels = [proxyModelId],
  { sessionId = null } = {},
) {
  const environment = Object.fromEntries(
    CLAUDE_PROVIDER_ENV_KEYS.map((name) => [name, ""]),
  );
  const active = buildClaudeCodexEnvironment(config, proxyModelId, {}, { sessionId });
  Object.assign(environment, active, {
    // A settings file cannot delete an inherited variable. Claude treats the
    // empty value as disabled and will fetch the complete gateway model list.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "",
  });
  return {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    model: proxyModelId,
    availableModels: [...new Set(availableModels)],
    enforceAvailableModels: true,
    env: environment,
  };
}

function validateSessionId(sessionId) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(sessionId ?? ""))) {
    throw new UserError(`Claude did not provide a valid resumable session ID: ${sessionId ?? "missing"}`);
  }
}

export function renderProxyConfig(config, key, aliases = []) {
  const lines = [
    '# Generated by CC Codex. Edit the controller, not this file.',
    'host: "127.0.0.1"',
    `port: ${config.proxyPort}`,
    "tls:",
    "  enable: false",
    '  cert: ""',
    '  key: ""',
    "remote-management:",
    "  allow-remote: false",
    '  secret-key: ""',
    "  disable-control-panel: true",
    `auth-dir: ${JSON.stringify(config.authDir)}`,
    "api-keys:",
    `  - ${JSON.stringify(key)}`,
    "debug: false",
    "logging-to-file: false",
    "logs-max-total-size-mb: 32",
    "error-logs-max-files: 2",
    `usage-statistics-enabled: ${config.traceEnabled ? "true" : "false"}`,
    "commercial-mode: true",
    'proxy-url: ""',
    "request-retry: 2",
    "max-retry-credentials: 1",
    "disable-cooling: false",
  ];
  if (aliases.length) {
    lines.push("oauth-model-alias:", "  codex:");
    for (const entry of aliases) {
      lines.push(
        `    - name: ${JSON.stringify(entry.name)}`,
        `      alias: ${JSON.stringify(entry.alias)}`,
        "      fork: true",
        "      force-mapping: true",
      );
    }
  }
  lines.push(
    "payload:",
    "  override:",
    "    - models:",
    '        - name: "gpt-*"',
    '          protocol: "codex"',
    "          headers:",
    `            X-CC-Codex-Fast: "1"`,
    "      params:",
    `        service_tier: "priority"`,
  );
  lines.push("");
  return lines.join("\n");
}

function readProxyAliasRecords(config) {
  const records = readJson(config.proxyAliasesPath);
  if (!Array.isArray(records)) return [];
  return records.filter(
    (entry) => typeof entry?.name === "string" && typeof entry?.alias === "string",
  );
}

export function syncProxyAliases(config, models) {
  if (!models.length) return [];
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const records = models.map((model) => ({
    name: model.id,
    alias: gatewayAliasForModel(model.id),
    kind: "gateway",
  }));
  for (const alias of CLAUDE_AUXILIARY_MODEL_IDS) {
    records.push({ name: defaultModel.id, alias, kind: "auxiliary" });
  }
  const serialized = `${JSON.stringify(records, null, 2)}\n`;
  if (!existsSync(config.proxyAliasesPath) || readFileSync(config.proxyAliasesPath, "utf8") !== serialized) {
    writeAtomic(config.proxyAliasesPath, serialized);
  }
  ensureState(config);
  return records;
}

function writeAtomic(path, contents, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, contents, { mode });
  renameSync(temporary, path);
}

function releaseAsset() {
  const platform = `${process.platform}-${process.arch}`;
  const asset = CLIPROXY_PIN.assets[platform];
  if (!asset) {
    throw new UserError(
      `CLIProxyAPI ${CLIPROXY_PIN.version} is not pinned for ${platform}. ` +
        "Supported: darwin/linux on arm64/x64.",
    );
  }
  return asset;
}

export function proxyBinaryPath(config = getConfig()) {
  return join(config.runtimeDir, "cliproxyapi", `v${CLIPROXY_PIN.version}`, "cli-proxy-api");
}

export async function ensureProxyInstalled(config = getConfig(), { quiet = false } = {}) {
  ensureState(config);
  const binary = proxyBinaryPath(config);
  if (existsSync(binary)) return binary;

  return withLock(config, "install", async () => {
    if (existsSync(binary)) return binary;
    const asset = releaseAsset();
    const installDir = dirname(binary);
    const staging = join(config.runtimeDir, `install-${process.pid}-${Date.now()}`);
    const archive = join(staging, asset.name);
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    if (!quiet) process.stderr.write(`Downloading pinned CLIProxyAPI v${CLIPROXY_PIN.version}...\n`);

    try {
      const url = `${CLIPROXY_PIN.repository}/releases/download/${CLIPROXY_PIN.tag}/${asset.name}`;
      runChecked("curl", ["-fsSL", url, "-o", archive]);
      const actual = await sha256File(archive);
      if (actual !== asset.sha256) {
        throw new UserError(
          `Checksum mismatch for ${asset.name}: expected ${asset.sha256}, received ${actual}`,
        );
      }
      runChecked("tar", ["-xzf", archive, "-C", staging]);
      const extracted = join(staging, "cli-proxy-api");
      if (!existsSync(extracted)) throw new UserError("CLIProxyAPI archive did not contain cli-proxy-api");
      mkdirSync(installDir, { recursive: true, mode: 0o700 });
      writeFileSync(binary, readFileSync(extracted), { mode: 0o755 });
      if (!quiet) process.stderr.write(`Installed ${binary}\n`);
      return binary;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
}

async function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectPromise);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw new UserError(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const output = [result.stderr, result.stdout]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .join("\n");
    throw new UserError(
      `${command} exited with status ${result.status}` +
        (output ? `\nCommand output:\n${redactDiagnostic(tailText(output))}` : ""),
    );
  }
  return result;
}

function executablePath(name) {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new UserError(`${name} is not installed or is not on PATH`);
  }
  return result.stdout.trim();
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function startupFailureMessage(error, logPath) {
  const message = error instanceof Error ? error.message : String(error);
  let output = "";
  try {
    output = readFileSync(logPath, "utf8");
  } catch {
    // A process can fail before opening its log file.
  }
  const tail = redactDiagnostic(tailText(output));
  return message +
    (tail ? `\nLast startup output:\n${tail}` : "\nNo startup output was produced.") +
    `\nLog: ${logPath}`;
}

function tailText(value, maxLines = 16, maxChars = 4_000) {
  const lines = String(value ?? "").trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines).join("\n").slice(-maxChars);
}

function redactDiagnostic(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted-api-key]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]");
}

function processCommand(pid) {
  if (!isPidAlive(pid)) return "";
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function managedPid(path, signature) {
  const record = readJson(path);
  if (!record || !isPidAlive(record.pid)) return null;
  const command = processCommand(record.pid);
  return signature(command, record) ? record.pid : null;
}

async function withLock(config, name, action, timeoutMs = 20_000) {
  return withDirectoryLock(config.locksDir, name, action, {
    timeoutMs,
    owner: { stateDir: config.stateDir },
  });
}

async function withDirectoryLock(lockDir, name, action, {
  timeoutMs = 20_000,
  owner = {},
} = {}) {
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const path = join(lockDir, `${name}.lock`);
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(
        join(path, "owner.json"),
        JSON.stringify({ pid: process.pid, at: Date.now(), version: CONTROLLER_VERSION, ...owner }),
        { mode: 0o600 },
      );
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = readJson(join(path, "owner.json"));
      let stale = false;
      try {
        stale = Date.now() - statSync(path).mtimeMs > 30_000;
      } catch {
        stale = true;
      }
      if (stale && (!owner || !isPidAlive(owner.pid))) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        const ownerDetail = owner?.pid
          ? ` The lock is held by PID ${owner.pid}.`
          : " The lock owner could not be identified.";
        throw new UserError(
          `Timed out waiting for the ${name} startup lock.${ownerDetail} ` +
            `Lock: ${path}\nRetry /codex:enable.`,
        );
      }
      await delay(100);
    }
  }

  try {
    return await action();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

export async function withServiceCoordination(config = getConfig(), action) {
  if (typeof action !== "function") throw new TypeError("CC Codex coordination requires an action");
  const name = `services-${config.gatewayPort}-${config.proxyPort}-${config.appServerPort}`;
  const lockPath = join(config.hostLocksDir, `${name}.lock`);
  if (serviceCoordinationContext.getStore() === lockPath) return action();
  return withDirectoryLock(
    config.hostLocksDir,
    name,
    () => serviceCoordinationContext.run(lockPath, action),
    {
      timeoutMs: 60_000,
      owner: {
        stateDir: config.stateDir,
        gatewayPort: config.gatewayPort,
        proxyPort: config.proxyPort,
        appServerPort: config.appServerPort,
      },
    },
  );
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 1_500) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

export async function proxyReady(config = getConfig()) {
  try {
    const health = await fetchWithTimeout(`${config.proxyBaseUrl}/healthz`);
    if (!health.ok) return false;
    const root = await fetchWithTimeout(`${config.proxyBaseUrl}/`);
    if (!root.ok) return false;
    const body = await root.json();
    if (body?.message !== "CLI Proxy API Server") return false;
    const key = readFileSync(config.proxyKeyPath, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(key)) return false;
    const models = await fetchWithTimeout(`${config.proxyBaseUrl}/v1/models`, {
      headers: {
        Authorization: `Bearer ${key}`,
        "Anthropic-Version": "2023-06-01",
      },
    });
    return models.ok;
  } catch {
    return false;
  }
}

export async function appServerReady(config = getConfig()) {
  try {
    const response = await fetchWithTimeout(`${config.appServerHttpUrl}/readyz`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function gatewayReady(config = getConfig()) {
  try {
    const response = await fetchWithTimeout(`${config.gatewayBaseUrl}/healthz`);
    if (!response.ok) return false;
    const body = await response.json();
    if (body?.service !== "claude-codex-gateway") return false;
    const key = readFileSync(config.proxyKeyPath, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(key)) return false;
    const models = await fetchWithTimeout(`${config.gatewayBaseUrl}/v1/models`, {
      headers: {
        Authorization: `Bearer ${key}`,
        "Anthropic-Version": "2023-06-01",
      },
    });
    return models.ok;
  } catch {
    return false;
  }
}

async function portIsListening(port, timeoutMs = 500) {
  return new Promise((resolvePromise) => {
    const socket = new Socket();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

function listeningProcess(port) {
  const result = spawnSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { encoding: "utf8" },
  );
  const pid = Number(String(result.stdout ?? "").trim().split(/\s+/)[0]);
  if (!Number.isInteger(pid) || pid <= 1) return null;
  return { pid, command: processCommand(pid) };
}

async function reclaimIdleCcCodexServices(config) {
  const owner = listeningProcess(config.proxyPort);
  const match = owner?.command.match(/\s-config\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const legacyConfigPath = match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  if (!legacyConfigPath || !existsSync(legacyConfigPath)) return false;
  let generated;
  try {
    generated = readFileSync(legacyConfigPath, "utf8").startsWith("# Generated by CC Codex.");
  } catch {
    generated = false;
  }
  if (!generated) return false;

  const stateDir = dirname(legacyConfigPath);
  const sessionsDir = join(stateDir, "sessions");
  const liveSessions = [];
  if (existsSync(sessionsDir)) {
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith(".json")) continue;
      const record = readJson(join(sessionsDir, name));
      const pid = record?.claudePid ?? record?.launcherPid;
      if (record && isPidAlive(pid)) liveSessions.push(record);
    }
  }
  const liveProcessPids = findLiveRoutedProcesses(stateDir).map((processRecord) => processRecord.pid);
  const livePids = [...new Set([
    ...liveSessions.map((session) => session.claudePid ?? session.launcherPid),
    ...liveProcessPids,
  ])];
  if (livePids.length) {
    throw new UserError(
      `An older CC Codex routed process is still active (PID ${livePids.join(", ")}) and owns ` +
        `port ${config.proxyPort}. ` +
      "This is a local service conflict, not a Codex login failure. " +
      "Close that Claude session, then run /codex:enable again.",
    );
  }

  const stoppedPids = new Set();
  for (const [name, label] of [
    ["claude-gateway.pid.json", "older CC Codex gateway"],
    ["cliproxy.pid.json", "older CC Codex proxy"],
    ["codex-app-server.pid.json", "older Codex app-server"],
  ]) {
    const path = join(stateDir, name);
    const record = readJson(path);
    if (isPidAlive(record?.pid)) {
      await stopPid(record.pid, label).catch(() => {});
      if (!isPidAlive(record.pid)) stoppedPids.add(record.pid);
    }
    rmSync(path, { force: true });
  }
  // Older releases can leave the listener alive after its PID record is lost.
  // The command and generated config above prove this PID is CC Codex-owned.
  if (isPidAlive(owner.pid) && !stoppedPids.has(owner.pid)) {
    await stopPid(owner.pid, "older CC Codex proxy").catch(() => {});
  }
  return true;
}

export function findLiveRoutedProcesses(stateDir) {
  const root = resolve(stateDir);
  const markers = [
    `${join(root, "session-modes")}/`,
    join(root, "shell", "terminal-launcher.mjs"),
  ];
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  const matches = [];
  for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
    const parsed = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!parsed) continue;
    const pid = Number(parsed[1]);
    if (pid === process.pid || !isPidAlive(pid)) continue;
    if (markers.some((marker) => parsed[2].includes(marker))) {
      matches.push({ pid, command: parsed[2] });
    }
  }
  return matches;
}

async function requireFreePort(config, label, port, { reclaim = false } = {}) {
  if (!(await portIsListening(port))) return;
  if (reclaim && await reclaimIdleCcCodexServices(config)) {
    const started = Date.now();
    while (await portIsListening(port)) {
      if (Date.now() - started > 3_000) break;
      await delay(100);
    }
    if (!(await portIsListening(port))) return;
  }
  const owner = listeningProcess(port);
  const detail = owner
    ? ` PID ${owner.pid}: ${owner.command.slice(0, 500)}`
    : " an unknown process";
  throw new UserError(
    `${label} cannot start because 127.0.0.1:${port} is already in use by${detail}. ` +
      "Stop that process, then run /codex:enable again.",
  );
}

async function waitUntil(check, label, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await delay(100);
  }
  throw new UserError(`${label} did not become ready within ${Math.round(timeoutMs / 1000)}s`);
}

function spawnDetached(binary, args, logPath, options = {}) {
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const out = openSync(logPath, "a", 0o600);
  const child = spawn(binary, args, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, ...(options.env ?? {}) },
  });
  child.unref();
  closeSync(out);
  return child.pid;
}

export async function ensureProxy(config = getConfig()) {
  return withServiceCoordination(config, () => ensureProxyCoordinated(config));
}

async function ensureProxyCoordinated(config, { forceRestart = false } = {}) {
  const { key } = ensureState(config);
  const localAuth = syncLocalCodexAuth(config);
  if (!localAuth.available) {
    throw new UserError(
      "Codex is not signed in on this machine. Run /codex:auth, then retry.",
    );
  }
  const signature = (cmd, record) =>
    cmd.includes("cli-proxy-api") && traceModeMatches(config, record);
  const reusablePid = managedPid(config.proxyPidPath, signature);
  if (!forceRestart && reusablePid && await proxyReady(config)) {
    return { pid: reusablePid, reused: true };
  }

  return withLock(config, "proxy", async () => {
    const lockedReusablePid = managedPid(config.proxyPidPath, signature);
    if (!forceRestart && lockedReusablePid && await proxyReady(config)) {
      return { pid: lockedReusablePid, reused: true };
    }
    const binary = await ensureProxyInstalled(config);
    const oldPid = managedPid(config.proxyPidPath, (cmd) => cmd.includes("cli-proxy-api"));
    if (oldPid) await stopPid(oldPid, "stale CLIProxyAPI");
    await requireFreePort(config, "CLIProxyAPI", config.proxyPort, { reclaim: true });

    const logPath = join(config.logsDir, "cliproxyapi.log");
    const pid = spawnDetached(
      binary,
      ["-config", config.proxyConfigPath],
      logPath,
      {
        env: {
          MANAGEMENT_PASSWORD: config.traceEnabled ? key : "",
        },
      },
    );
    writeAtomic(
      config.proxyPidPath,
      `${JSON.stringify({
        pid,
        binary,
        port: config.proxyPort,
        traceEnabled: config.traceEnabled,
        startedAt: new Date().toISOString(),
      })}\n`,
    );
    try {
      await waitUntil(() => proxyReady(config), "CLIProxyAPI");
    } catch (error) {
      await stopPid(pid, "CLIProxyAPI", 2_000).catch(() => {});
      throw new UserError(startupFailureMessage(error, logPath));
    }
    return { pid, reused: false };
  });
}

export async function ensureAppServer(config = getConfig()) {
  return withServiceCoordination(config, () => ensureAppServerCoordinated(config));
}

async function ensureAppServerCoordinated(config) {
  ensureState(config);
  if (await appServerReady(config)) {
    return {
      pid: managedPid(
        config.appServerPidPath,
        (cmd) => cmd.includes("app-server") && cmd.includes(String(config.appServerPort)),
      ),
      reused: true,
    };
  }

  return withLock(config, "app-server", async () => {
    if (await appServerReady(config)) {
      return {
        pid: managedPid(
          config.appServerPidPath,
          (cmd) => cmd.includes("app-server") && cmd.includes(String(config.appServerPort)),
        ),
        reused: true,
      };
    }
    const codex = executablePath("codex");
    const oldPid = managedPid(
      config.appServerPidPath,
      (cmd) => cmd.includes("app-server") && cmd.includes(String(config.appServerPort)),
    );
    if (oldPid) await stopPid(oldPid, "stale Codex app-server");
    await requireFreePort(config, "Codex app-server", config.appServerPort);
    const logPath = join(config.logsDir, "codex-app-server.log");
    const pid = spawnDetached(
      codex,
      ["app-server", "--listen", config.appServerWsUrl],
      logPath,
    );
    writeAtomic(
      config.appServerPidPath,
      `${JSON.stringify({ pid, binary: codex, port: config.appServerPort, startedAt: new Date().toISOString() })}\n`,
    );
    try {
      await waitUntil(() => appServerReady(config), "Codex app-server");
    } catch (error) {
      await stopPid(pid, "Codex app-server", 2_000).catch(() => {});
      throw new UserError(startupFailureMessage(error, logPath));
    }
    return { pid, reused: false };
  });
}

export async function ensureGateway(config = getConfig()) {
  return withServiceCoordination(config, () => ensureGatewayCoordinated(config));
}

async function ensureGatewayCoordinated(config) {
  ensureState(config);
  await ensureProxy(config);
  const signature = (cmd, record) =>
    cmd.includes("gateway.mjs") &&
    cmd.includes(String(config.gatewayPort)) &&
    traceModeMatches(config, record);
  const reusablePid = managedPid(config.gatewayPidPath, signature);
  if (reusablePid && await gatewayReady(config)) {
    return { pid: reusablePid, reused: true };
  }

  return withLock(config, "gateway", async () => {
    const lockedReusablePid = managedPid(config.gatewayPidPath, signature);
    if (lockedReusablePid && await gatewayReady(config)) {
      return { pid: lockedReusablePid, reused: true };
    }
    const oldPid = managedPid(
      config.gatewayPidPath,
      (cmd) => cmd.includes("gateway.mjs") && cmd.includes(String(config.gatewayPort)),
    );
    if (oldPid) await stopPid(oldPid, "stale Claude gateway");
    await requireFreePort(config, "Claude gateway", config.gatewayPort);
    const script = join(ROOT, "lib", "gateway.mjs");
    const logPath = join(config.logsDir, "claude-gateway.log");
    const pid = spawnDetached(
      process.execPath,
      [script, "--port", String(config.gatewayPort)],
      logPath,
      {
        env: {
          CLAUDE_CODEX_GATEWAY_PORT: String(config.gatewayPort),
          CLAUDE_CODEX_PROXY_BASE_URL: config.proxyBaseUrl,
          CLAUDE_CODEX_PROXY_KEY_PATH: config.proxyKeyPath,
          CLAUDE_CODEX_STATE_DIR: config.stateDir,
          CLAUDE_CODEX_TRACE: config.traceEnabled ? "1" : "0",
          CLAUDE_CODEX_TRACE_PATH: config.tracePath,
        },
      },
    );
    writeAtomic(
      config.gatewayPidPath,
      `${JSON.stringify({
        pid,
        binary: process.execPath,
        port: config.gatewayPort,
        traceEnabled: config.traceEnabled,
        startedAt: new Date().toISOString(),
      })}\n`,
    );
    try {
      await waitUntil(() => gatewayReady(config), "Claude gateway");
    } catch (error) {
      await stopPid(pid, "Claude gateway", 2_000).catch(() => {});
      throw new UserError(startupFailureMessage(error, logPath));
    }
    return { pid, reused: false };
  });
}

function traceModeMatches(config, record) {
  return Boolean(record?.traceEnabled) === Boolean(config.traceEnabled);
}

async function stopPid(pid, label, timeoutMs = 5_000) {
  if (!isPidAlive(pid)) return;
  signalDetachedProcessGroup(pid, "SIGTERM");
  const started = Date.now();
  while (isPidAlive(pid) && Date.now() - started < timeoutMs) await delay(100);
  if (isPidAlive(pid)) {
    signalDetachedProcessGroup(pid, "SIGKILL");
    await delay(100);
  }
  if (isPidAlive(pid)) throw new UserError(`Could not stop ${label} (PID ${pid})`);
}

function signalDetachedProcessGroup(pid, signal) {
  try {
    // Services are spawned detached, so this also reaches the npm Codex launcher child.
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    process.kill(pid, signal);
  }
}

export function listSessions(config = getConfig()) {
  ensureState(config);
  const live = [];
  for (const name of readdirSync(config.sessionsDir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(config.sessionsDir, name);
    const record = readJson(path);
    const pid = record?.claudePid ?? record?.launcherPid;
    if (record && isPidAlive(pid)) live.push(record);
    else rmSync(path, { force: true });
  }
  return live;
}

export function registerSession(config, record) {
  ensureState(config);
  const identity = record.sessionId ?? `pid-${record.claudePid ?? process.pid}`;
  if (!/^[a-zA-Z0-9-]+$/.test(identity)) {
    throw new UserError(`Invalid session marker identity: ${identity}`);
  }
  const path = join(config.sessionsDir, `${identity}.json`);
  writeAtomic(path, `${JSON.stringify(record)}\n`);
  return () => rmSync(path, { force: true });
}

export function unregisterSession(config, { sessionId = null, claudePid = null } = {}) {
  ensureState(config);
  if (sessionId) {
    validateSessionId(sessionId);
    rmSync(join(config.sessionsDir, `${sessionId}.json`), { force: true });
    return;
  }
  if (claudePid) rmSync(join(config.sessionsDir, `pid-${claudePid}.json`), { force: true });
}

export async function stopServices(config = getConfig(), { force = false } = {}) {
  return withServiceCoordination(
    config,
    () => stopServicesCoordinated(config, { force }),
  );
}

async function stopServicesCoordinated(config, { force = false } = {}) {
  const sessions = listSessions(config);
  if (sessions.length && !force) {
    throw new UserError(
      `${sessions.length} CC Codex session${sessions.length === 1 ? " is" : "s are"} active. ` +
        "Close them before stopping the shared services.",
    );
  }

  const gatewayPid = managedPid(
    config.gatewayPidPath,
    (cmd) => cmd.includes("gateway.mjs") && cmd.includes(String(config.gatewayPort)),
  );
  const proxyPid = managedPid(config.proxyPidPath, (cmd) => cmd.includes("cli-proxy-api"));
  const appPid = managedPid(
    config.appServerPidPath,
    (cmd) => cmd.includes("app-server") && cmd.includes(String(config.appServerPort)),
  );
  if (gatewayPid) await stopPid(gatewayPid, "Claude gateway");
  if (proxyPid) await stopPid(proxyPid, "CLIProxyAPI");
  if (appPid) await stopPid(appPid, "Codex app-server");
  rmSync(config.gatewayPidPath, { force: true });
  rmSync(config.proxyPidPath, { force: true });
  rmSync(config.appServerPidPath, { force: true });
  return { gatewayPid, proxyPid, appPid };
}

class RpcClient {
  constructor(url) {
    this.url = url;
    this.sequence = 0;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new UserError("Timed out opening Codex app-server")), 10_000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolvePromise();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectPromise(new UserError("Could not connect to Codex app-server"));
      }, { once: true });
    });
    this.socket.addEventListener("message", (event) => this.onMessage(event));
    this.socket.addEventListener("close", () => this.rejectAll("Codex app-server connection closed"));
    await this.call("initialize", {
      clientInfo: { name: "cc-codex", version: CONTROLLER_VERSION },
      capabilities: { experimentalApi: true },
    });
  }

  onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id === undefined || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new UserError(`Codex RPC failed: ${JSON.stringify(message.error)}`));
    else pending.resolve(message.result);
  }

  call(method, params = null) {
    return new Promise((resolvePromise, rejectPromise) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) rejectPromise(new UserError(`Codex RPC timed out: ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  rejectAll(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new UserError(message));
    }
    this.pending.clear();
  }

  close() {
    this.socket?.close();
  }
}

export async function withCodexRpc(config, action) {
  await ensureAppServer(config);
  const client = new RpcClient(config.appServerWsUrl);
  await client.connect();
  try {
    return await action(client);
  } finally {
    client.close();
  }
}

export async function getNativeModels(config = getConfig()) {
  return withCodexRpc(config, async (client) => {
    const models = [];
    let cursor = null;
    do {
      const result = await client.call("model/list", { cursor, includeHidden: false, limit: 100 });
      models.push(...(result?.data ?? []));
      cursor = result?.nextCursor ?? null;
    } while (cursor);
    return models.filter((model) => !model.hidden);
  });
}

export async function getUsageSnapshot(config = getConfig()) {
  return withCodexRpc(config, async (client) => {
    const account = redactAccountEmail(
      await client.call("account/read", { refreshToken: false }),
    );
    const rateLimits = await client.call("account/rateLimits/read", null);
    let usage = null;
    let usageError = null;
    try {
      usage = await client.call("account/usage/read", null);
    } catch (error) {
      usageError = error.message;
    }
    return { account, rateLimits, usage, usageError, capturedAt: new Date().toISOString() };
  });
}

function redactAccountEmail(result) {
  if (!result?.account || !("email" in result.account)) return result;
  const { email: _email, ...account } = result.account;
  return { ...result, account };
}

export function codexAuthRecords(config = getConfig()) {
  ensureState(config);
  const records = [];
  for (const name of readdirSync(config.authDir)) {
    if (!name.endsWith(".json")) continue;
    const record = readJson(join(config.authDir, name));
    if (record?.type === "codex") {
      records.push({ file: name, type: "codex", planType: record.plan_type ?? null });
    }
  }
  return records;
}

export async function getProxyModels(config = getConfig()) {
  return withServiceCoordination(config, async () => {
    await ensureProxyCoordinated(config);
    const { key } = ensureState(config);
    try {
      return await fetchProxyModels(config, key);
    } catch (error) {
      if (!(error instanceof LocalProxyKeyMismatchError)) throw error;
    }

    await ensureProxyCoordinated(config, { forceRestart: true });
    const { key: recoveredKey } = ensureState(config);
    try {
      return await fetchProxyModels(config, recoveredKey);
    } catch (error) {
      if (!(error instanceof LocalProxyKeyMismatchError)) throw error;
      const owner = listeningProcess(config.proxyPort);
      const ownerDetail = owner
        ? ` Port ${config.proxyPort} is owned by PID ${owner.pid}: ${owner.command.slice(0, 500)}.`
        : ` No process owner could be identified for port ${config.proxyPort}.`;
      throw new UserError(
        "CLIProxyAPI rejected CC Codex's private local key after automatic recovery. " +
          "This is a local CC Codex service conflict, not a Codex login failure." +
          ownerDetail +
          " Close any older CC Codex session, then retry /codex:enable.",
      );
    }
  });
}

class LocalProxyKeyMismatchError extends Error {
  constructor() {
    super("CLIProxyAPI rejected the current CC Codex private local key");
    this.name = "LocalProxyKeyMismatchError";
  }
}

async function fetchProxyModels(config, key) {
  let response;
  try {
    response = await fetchWithTimeout(
      `${config.proxyBaseUrl}/v1/models`,
      {
        headers: {
          Authorization: `Bearer ${key}`,
          "Anthropic-Version": "2023-06-01",
          "User-Agent": "claude-cli/cc-codex",
        },
      },
      5_000,
    );
  } catch (error) {
    throw new UserError(`Could not read CLIProxyAPI model catalog: ${error.message}`);
  }
  const text = await response.text();
  if (response.status === 401 && isLocalProxyKeyRejection(text)) {
    throw new LocalProxyKeyMismatchError();
  }
  if (!response.ok) {
    throw new UserError(
      `CLIProxyAPI /v1/models returned ${response.status}: ${redactDiagnostic(tailText(text))}`,
    );
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new UserError("CLIProxyAPI /v1/models returned invalid JSON");
  }
  return (body?.data ?? []).map((model) => ({
    ...model,
    rawId: decodeGatewayModelAlias(model.id) ?? decodeClaudeModelId(model.id),
  }));
}

function isLocalProxyKeyRejection(text) {
  try {
    const body = JSON.parse(text);
    return body?.error === "Invalid API key";
  } catch {
    return /^\s*\{?\s*["']?error["']?\s*:\s*["']Invalid API key["']/i.test(text);
  }
}

export async function getModelCatalog(config = getConfig()) {
  const native = await getNativeModels(config);
  const aliases = syncProxyAliases(config, native).filter((entry) => entry.kind === "gateway");
  const expectedAliases = new Set(aliases.map((entry) => entry.alias));
  let proxy = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    proxy = await getProxyModels(config);
    if ([...expectedAliases].every((alias) => proxy.some((model) => model.id === alias))) break;
    await delay(100);
  }
  // CLIProxyAPI also exposes its own Claude-shaped aliases. Prefer the aliases
  // we generate for gateway discovery so --model and Claude's /model picker
  // refer to the same stable ID.
  const proxyByRaw = indexPreferredProxyModels(proxy);
  const available = native
    .filter((model) => proxyByRaw.has(model.id) || proxyByRaw.has(model.model))
    .map((model) => ({
      ...model,
      proxy: proxyByRaw.get(model.id) ?? proxyByRaw.get(model.model),
    }));
  return { native, proxy, available };
}

export function indexPreferredProxyModels(proxyModels) {
  const proxyByRaw = new Map();
  for (const model of proxyModels) {
    const current = proxyByRaw.get(model.rawId);
    if (!current || model.id.startsWith(GATEWAY_MODEL_PREFIX)) {
      proxyByRaw.set(model.rawId, model);
    }
  }
  return proxyByRaw;
}

export function resolveSelectedModel(catalog, selected = null) {
  if (!catalog.available.length) {
    throw new UserError(
      "No Codex models are available. Run /codex:auth, then retry.",
    );
  }
  if (selected) {
    const match = catalog.available.find(
      (model) => model.id === selected || model.model === selected || model.proxy.id === selected,
    );
    if (!match) {
      throw new UserError(
        `Model ${selected} is not in the current Codex catalog. Use /model and choose an available model.`,
      );
    }
    return match;
  }
  return catalog.available.find((model) => model.isDefault) ?? catalog.available[0];
}

export async function runCodexLogin(config = getConfig(), { device = false } = {}) {
  const codex = executablePath("codex");
  const child = spawn(codex, ["login", ...(device ? ["--device-auth"] : [])], {
    cwd: ROOT,
    stdio: "inherit",
  });
  const status = await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  if (status.code !== 0) throw new UserError(`codex login exited with status ${status.code}`);
  const localAuth = syncLocalCodexAuth(config);
  if (!localAuth.available) {
    throw new UserError("Codex login finished without creating a local ChatGPT credential.");
  }
  return localAuth;
}

export function serviceStatus(config = getConfig()) {
  const gatewayRecord = readJson(config.gatewayPidPath);
  const proxyRecord = readJson(config.proxyPidPath);
  const appRecord = readJson(config.appServerPidPath);
  const gatewayPid = managedPid(
    config.gatewayPidPath,
    (cmd) => cmd.includes("gateway.mjs") && cmd.includes(String(config.gatewayPort)),
  );
  const proxyPid = managedPid(config.proxyPidPath, (cmd) => cmd.includes("cli-proxy-api"));
  const appPid = managedPid(
    config.appServerPidPath,
    (cmd) => cmd.includes("app-server") && cmd.includes(String(config.appServerPort)),
  );
  return {
    gateway: { running: Boolean(gatewayPid), pid: gatewayPid, record: gatewayRecord },
    proxy: { running: Boolean(proxyPid), pid: proxyPid, record: proxyRecord },
    appServer: { running: Boolean(appPid), pid: appPid, record: appRecord },
    sessions: listSessions(config),
    authRecords: codexAuthRecords(config),
  };
}

export function formatUsage(snapshot) {
  const rows = [];
  const account = snapshot.account?.account;
  const plan = account?.planType ? titleCase(account.planType) : "unknown";
  rows.push({
    label: "Account",
    value: account?.type === "chatgpt"
      ? `ChatGPT ${plan}`
      : account?.type ?? "not logged in",
  });

  const capturedAt = snapshot.capturedAt ?? new Date().toISOString();
  const buckets = snapshot.rateLimits?.rateLimitsByLimitId;
  const entries = buckets && Object.keys(buckets).length
    ? Object.entries(buckets)
    : [[snapshot.rateLimits?.rateLimits?.limitId ?? "codex", snapshot.rateLimits?.rateLimits]];
  for (const [id, bucket] of entries) {
    if (!bucket) continue;
    rows.push(...rateLimitRows(id, bucket, capturedAt));
  }

  const resetCredits = snapshot.rateLimits?.rateLimitResetCredits?.availableCount;
  if (resetCredits !== undefined && resetCredits !== null) {
    rows.push({ label: "Rate-limit reset credits", value: String(resetCredits) });
  }
  const summary = snapshot.usage?.summary;
  if (summary?.lifetimeTokens != null) {
    rows.push({ label: "Lifetime tokens", value: formatInteger(summary.lifetimeTokens) });
  }
  if (summary?.currentStreakDays != null) {
    rows.push({
      label: "Current streak",
      value: `${summary.currentStreakDays} days (longest ${summary.longestStreakDays ?? "unknown"})`,
    });
  }
  if (snapshot.usageError) {
    rows.push({ label: "Token history unavailable", value: snapshot.usageError });
  }
  rows.push({ label: "Captured", value: formatCapturedTimestamp(capturedAt) });
  return ["Codex subscription usage", "", ...renderUsageRows(rows)].join("\n");
}

function rateLimitRows(id, bucket, capturedAt) {
  const rows = [];
  const windows = [
    ["primary", bucket.primary],
    ["secondary", bucket.secondary],
  ].filter(([, window]) => Boolean(window));
  const bucketLabel = String(bucket.limitName || id);
  const showBucketLabel = String(id).toLowerCase() !== "codex";
  const combineSingleWindow = showBucketLabel && windows.length === 1;

  if (showBucketLabel && !combineSingleWindow && windows.length) {
    rows.push({ label: `${bucketLabel} limit`, value: "" });
  }

  for (const [windowName, window] of windows) {
    const duration = capitalizeFirst(limitDuration(window.windowDurationMins, windowName));
    const label = combineSingleWindow
      ? `${bucketLabel} ${duration} limit`
      : `${duration} limit`;
    const usedPercent = Number.isFinite(Number(window.usedPercent))
      ? Math.min(100, Math.max(0, Number(window.usedPercent)))
      : 0;
    const remainingPercent = 100 - usedPercent;
    const reset = formatResetTimestamp(window.resetsAt, capturedAt);
    rows.push({
      label,
      value:
        `${renderUsageBar(remainingPercent)} ${Math.round(remainingPercent)}% left` +
        (reset ? ` (resets ${reset})` : ""),
    });
  }
  return rows;
}

function limitDuration(minutes, windowName) {
  const value = Math.max(0, Number(minutes));
  const windows = [
    [300, "5h"],
    [1_440, "daily"],
    [10_080, "weekly"],
    [43_200, "monthly"],
    [525_600, "annual"],
  ];
  if (Number.isFinite(value)) {
    for (const [expected, label] of windows) {
      if (value >= expected * 0.95 && value <= expected * 1.05) return label;
    }
  }
  return windowName === "secondary" ? "secondary usage" : "usage";
}

function renderUsageBar(percentRemaining) {
  const segments = 20;
  const ratio = Math.min(1, Math.max(0, percentRemaining / 100));
  const filled = Math.min(segments, Math.round(ratio * segments));
  return `[${"█".repeat(filled)}${"░".repeat(segments - filled)}]`;
}

function formatResetTimestamp(seconds, capturedAt) {
  if (seconds === undefined || seconds === null) return null;
  const reset = new Date(Number(seconds) * 1000);
  const captured = new Date(capturedAt);
  if (Number.isNaN(reset.getTime()) || Number.isNaN(captured.getTime())) return null;
  const time = `${String(reset.getHours()).padStart(2, "0")}:${String(reset.getMinutes()).padStart(2, "0")}`;
  if (
    reset.getFullYear() === captured.getFullYear() &&
    reset.getMonth() === captured.getMonth() &&
    reset.getDate() === captured.getDate()
  ) return time;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${time} on ${reset.getDate()} ${months[reset.getMonth()]}`;
}

function formatCapturedTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}

function renderUsageRows(rows) {
  const width = rows.reduce((longest, row) => Math.max(longest, row.label.length), 0);
  return rows.map(({ label, value }) => {
    const prefix = ` ${label}:`;
    if (!value) return prefix;
    return `${prefix}${" ".repeat(3 + width - label.length)}${value}`;
  });
}

function capitalizeFirst(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function titleCase(value) {
  return value
    .replaceAll("_", " ")
    .split(" ")
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(" ");
}
