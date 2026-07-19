import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

import {
  CLAUDE_PROVIDER_ENV_KEYS,
  GATEWAY_MODEL_PREFIX,
  UserError,
  decodeGatewayModelAlias,
  ensureAppServer,
  ensureGateway,
  ensureProxy,
  ensureState,
  getModelCatalog,
  renderClaudeCodexSettings,
  resolveSelectedModel,
  syncLocalCodexAuth,
  withServiceCoordination,
} from "./core.mjs";
import {
  fastModelIds,
  modelSupportsFast,
  recordSupportsFast,
  recordUsesFast,
} from "./fast.mjs";

const ROUTE_VERSION = 1;
const MODE_VERSION = 1;
const ZSHRC_START = "# >>> cc-codex >>>";
const ZSHRC_END = "# <<< cc-codex <<<";
const LEGACY_ZSHRC_START = "# >>> claude-codex-mode >>>";
const LEGACY_ZSHRC_END = "# <<< claude-codex-mode <<<";

export function validateSessionId(sessionId) {
  const value = String(sessionId ?? "");
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new UserError(`Claude did not provide a valid resumable session ID: ${value || "missing"}`);
  }
  return value;
}

export function normalizeTerminalIdentity({ shellPid, tty } = {}) {
  const pid = Number(shellPid);
  const normalizedTty = String(tty ?? "").trim().replace(/^\/dev\//, "");
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new UserError("Could not identify the parent terminal shell PID.");
  }
  if (!normalizedTty || normalizedTty === "?" || !/^[a-zA-Z0-9._/-]+$/.test(normalizedTty)) {
    throw new UserError("Could not identify this terminal's TTY.");
  }
  return {
    shellPid: pid,
    tty: normalizedTty,
    key: createHash("sha256").update(`${pid}\0${normalizedTty}`).digest("hex"),
  };
}

export function deriveTerminalIdentity({
  environment = process.env,
  claudePid = process.ppid,
} = {}) {
  if (environment.CLAUDE_CODEX_SHELL_PID && environment.CLAUDE_CODEX_TTY) {
    return normalizeTerminalIdentity({
      shellPid: environment.CLAUDE_CODEX_SHELL_PID,
      tty: environment.CLAUDE_CODEX_TTY,
    });
  }

  const pid = Number(claudePid);
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new UserError("Claude did not expose a usable process ID for terminal-scoped mode.");
  }
  const result = spawnSync(
    "ps",
    ["-p", String(pid), "-o", "ppid=", "-o", "tty="],
    { encoding: "utf8" },
  );
  const match = result.status === 0
    ? String(result.stdout ?? "").trim().match(/^(\d+)\s+(\S+)$/)
    : null;
  if (!match) {
    throw new UserError("Could not map this Claude process to its parent terminal shell.");
  }
  return normalizeTerminalIdentity({ shellPid: match[1], tty: match[2] });
}

export function terminalRoutePath(config, terminalIdentity) {
  const terminal = normalizeTerminalIdentity(terminalIdentity);
  return join(config.terminalRoutesDir, `${terminal.key}.json`);
}

export function sessionModePath(config, sessionId) {
  return join(config.sessionModesDir, `${validateSessionId(sessionId)}.json`);
}

export function sessionSettingsPath(config, sessionId) {
  return join(config.sessionModesDir, `${validateSessionId(sessionId)}.settings.json`);
}

export function readSessionMode(config, sessionId) {
  const record = readJson(sessionModePath(config, sessionId));
  return validSessionMode(record) ? record : null;
}

export function readTerminalRoute(config, terminalIdentity) {
  const terminal = normalizeTerminalIdentity(terminalIdentity);
  const route = readJson(join(config.terminalRoutesDir, `${terminal.key}.json`));
  if (!validTerminalRoute(route)) return null;
  if (
    route.key !== terminal.key || route.terminal.shellPid !== terminal.shellPid ||
    route.terminal.tty !== terminal.tty
  ) return null;
  return route;
}

export function listTerminalRoutes(config, { prune = true } = {}) {
  ensureState(config);
  const routes = [];
  for (const name of readdirSync(config.terminalRoutesDir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(config.terminalRoutesDir, name);
    const route = readJson(path);
    if (!validTerminalRoute(route)) {
      if (prune) rmSync(path, { force: true });
      continue;
    }
    if (prune && !terminalIsAlive(route.terminal)) {
      removeRouteAndOrphanedMode(config, route, path);
      continue;
    }
    if (!readSessionMode(config, route.sessionId)) {
      if (prune) rmSync(path, { force: true });
      continue;
    }
    routes.push(route);
  }
  return routes;
}

export function terminalModeStatus(config, {
  terminalIdentity = null,
  sessionId = process.env.CLAUDE_CODEX_SESSION_ID ?? null,
} = {}) {
  const routes = listTerminalRoutes(config);
  let mode = sessionId ? readSessionMode(config, sessionId) : null;
  let route = null;
  if (!mode && terminalIdentity) {
    route = readTerminalRoute(config, terminalIdentity);
    mode = route ? readSessionMode(config, route.sessionId) : null;
  } else if (mode) {
    route = routes.find((candidate) => candidate.sessionId === mode.sessionId) ?? null;
  }
  return {
    enabled: Boolean(mode),
    routeCount: routes.length,
    mode,
    route,
  };
}

export function pendingRouteNotice(config, {
  terminalIdentity,
  cwd,
  shellIntegrationActive = false,
  bypassReason = null,
} = {}) {
  const intentionalBypasses = new Set([
    "bypass requested",
    "different resume target",
    "explicit Claude launch mode",
  ]);
  if (intentionalBypasses.has(bypassReason)) return null;

  let route = null;
  try {
    route = readTerminalRoute(config, terminalIdentity);
  } catch {
    // A normal Claude launch without a pending route should remain untouched.
  }

  if (!route) {
    if (["invalid route state", "session settings missing", "route planning failed"].includes(bypassReason)) {
      return "CC Codex could not use its saved route because the route state is invalid. " +
        "Run /codex:enable again in this conversation.";
    }
    return null;
  }

  const mode = readSessionMode(config, route.sessionId);
  if (!mode) {
    return "CC Codex found a terminal route without valid session settings. " +
      "Run /codex:enable again in this conversation.";
  }

  const launchCwd = resolve(String(cwd || process.cwd()));
  if (!samePath(launchCwd, route.cwd)) {
    const command = shellIntegrationActive
      ? `cd ${shellQuote(route.cwd)} && claude`
      : `cd ${shellQuote(route.cwd)} && ${shellActivationCommand(config)}`;
    return "CC Codex did not route this launch because it started from a different directory.\n\n" +
      `Exit Claude, then run exactly:\n${command}`;
  }

  if (!shellIntegrationActive) {
    return "CC Codex was enabled, but this shell has not loaded the CC Codex launcher.\n\n" +
      `Exit Claude, then run exactly:\n${shellActivationCommand(config)}`;
  }

  if (bypassReason) {
    return `CC Codex did not route this launch: ${bypassReason}. ` +
      "Run /codex:enable again in this conversation.";
  }
  return null;
}

export async function prepareTerminalSessionMode(config, options = {}) {
  return withServiceCoordination(
    config,
    () => prepareTerminalSessionModeCoordinated(config, options),
  );
}

async function prepareTerminalSessionModeCoordinated(config, {
  sessionId,
  cwd,
  permissionMode = null,
  requestedModel = null,
  terminalIdentity,
  environment = process.env,
} = {}) {
  restoreLegacyGlobalMode(config);
  ensureState(config);
  const id = validateSessionId(sessionId);
  const terminal = normalizeTerminalIdentity(terminalIdentity);
  if (!syncLocalCodexAuth(config).available) {
    throw new UserError(
      "Codex is not signed in on this machine. Run /codex:auth, then retry /codex:enable.",
    );
  }

  const previous = readSessionMode(config, id);
  const preferredModel = requestedModel ?? previous?.selectedModelId ?? null;
  const catalog = await getModelCatalog(config);
  const [gatewayService, proxyService, appService] = await Promise.all([
    ensureGateway(config),
    ensureProxy(config),
    ensureAppServer(config),
  ]);
  const selected = resolveSelectedModel(catalog, preferredModel);
  const proxyModelId = selected.proxy.id;
  const availableModels = catalog.available.map((model) => model.proxy.id);
  const supportedFastModels = fastModelIds(catalog.available);
  const selectedSupportsFast = supportedFastModels.includes(selected.id) ||
    supportedFastModels.includes(selected.model);
  const settingsPath = sessionSettingsPath(config, id);
  const now = new Date().toISOString();
  const record = {
    version: MODE_VERSION,
    sessionId: id,
    cwd: resolve(String(cwd || process.cwd())),
    permissionMode: normalizePermissionMode(permissionMode),
    proxyModelId,
    selectedModelId: selected.id,
    selectedModelDisplayName: selected.displayName ?? selected.id,
    availableModels,
    fastModelIds: supportedFastModels,
    fastMode: previous?.fastMode === true && selectedSupportsFast,
    settingsPath,
    terminal,
    enabledAt: previous?.enabledAt ?? now,
    updatedAt: now,
  };

  removeRoutesForSession(config, id);
  const priorRoute = readTerminalRoute(config, terminal);
  if (priorRoute && priorRoute.sessionId !== id) removeSessionMode(config, priorRoute.sessionId);
  writeSettingsForMode(config, record);
  writeJson(sessionModePath(config, id), record);
  const route = {
    version: ROUTE_VERSION,
    key: terminal.key,
    terminal,
    sessionId: id,
    cwd: record.cwd,
    createdAt: priorRoute?.createdAt ?? now,
    updatedAt: now,
  };
  writeJson(terminalRoutePath(config, terminal), route);
  const shell = installShellIntegration(config, { environment });

  return {
    selected,
    proxyModelId,
    record,
    route,
    shell,
    gatewayService,
    proxyService,
    appService,
  };
}

export function disableSessionMode(config, { sessionId } = {}) {
  restoreLegacyGlobalMode(config);
  const id = validateSessionId(sessionId);
  const record = readSessionMode(config, id);
  removeRoutesForSession(config, id);
  removeSessionMode(config, id);
  return { wasEnabled: Boolean(record), sessionId: id };
}

export function markSessionStarted(config, { sessionId, model = null } = {}) {
  restoreLegacyGlobalMode(config);
  const record = readSessionMode(config, sessionId);
  if (!record) return null;
  const updated = updateRecordModel(record, model);
  // Remove the pre-0.9.3 one-shot marker when an older mode record is reused.
  // The launcher now passes the persisted selection on every routed resume.
  delete updated.forceModelOnNextLaunch;
  updated.updatedAt = new Date().toISOString();
  writeSettingsForMode(config, updated);
  writeJson(sessionModePath(config, updated.sessionId), updated);
  return updated;
}

export function updateSessionFromTranscript(config, {
  sessionId,
  transcriptPath = null,
  model = null,
} = {}) {
  const record = readSessionMode(config, sessionId);
  if (!record) return null;
  const transcriptModel = transcriptPath ? lastAssistantModel(transcriptPath) : null;
  const updated = updateRecordModel(record, transcriptModel ?? model);
  updated.updatedAt = new Date().toISOString();
  writeSettingsForMode(config, updated);
  writeJson(sessionModePath(config, updated.sessionId), updated);
  return updated;
}

export async function setSessionFastMode(config, {
  sessionId,
  action = "toggle",
  catalog = null,
} = {}) {
  restoreLegacyGlobalMode(config);
  ensureState(config);
  const id = validateSessionId(sessionId);
  const record = readSessionMode(config, id);
  if (!record) {
    throw new UserError("Codex is not enabled for this conversation. Run /codex:enable first.");
  }

  const normalizedAction = String(action || "toggle").trim().toLowerCase();
  if (!["toggle", "on", "off", "status"].includes(normalizedAction)) {
    throw new UserError("Usage: /codex:fast [on|off|status]");
  }

  const liveCatalog = catalog ?? await getModelCatalog(config);
  const current = liveCatalog.available.find((model) =>
    model.id === record.selectedModelId || model.model === record.selectedModelId ||
    model.proxy?.id === record.proxyModelId,
  );
  if (!current) {
    throw new UserError(
      `The selected Codex model ${record.selectedModelId} is no longer available. Use /model first.`,
    );
  }

  const supportedIds = fastModelIds(liveCatalog.available);
  const supported = modelSupportsFast(current);
  const wasEnabled = record.fastMode === true && supported;
  if (!supported && ["toggle", "on"].includes(normalizedAction)) {
    const alternatives = liveCatalog.available
      .filter(modelSupportsFast)
      .map((model) => model.displayName ?? model.id)
      .join(", ");
    throw new UserError(
      `${current.displayName ?? current.id} does not offer Codex Fast mode.` +
        (alternatives ? ` Use /model and choose one of: ${alternatives}.` : ""),
    );
  }

  let enabled = wasEnabled;
  if (normalizedAction === "toggle") enabled = !wasEnabled;
  else if (normalizedAction === "on") enabled = true;
  else if (normalizedAction === "off") enabled = false;

  const updated = {
    ...record,
    selectedModelDisplayName: current.displayName ?? current.id,
    fastModelIds: supportedIds,
    fastMode: enabled && supported,
    updatedAt: new Date().toISOString(),
  };
  writeSettingsForMode(config, updated);
  writeJson(sessionModePath(config, id), updated);
  return {
    action: normalizedAction,
    enabled: recordUsesFast(updated),
    supported,
    changed: recordUsesFast(updated) !== wasEnabled,
    modelId: current.id,
    modelDisplayName: current.displayName ?? current.id,
  };
}

export function sessionFastStatus(record) {
  return {
    supported: recordSupportsFast(record),
    enabled: recordUsesFast(record),
  };
}

export function installShellIntegration(config, { environment = process.env } = {}) {
  ensureState(config);
  if (!existsSync(config.terminalLauncherSourcePath)) {
    throw new UserError(`Terminal launcher is missing from the plugin: ${config.terminalLauncherSourcePath}`);
  }
  const launcher = readFileSync(config.terminalLauncherSourcePath, "utf8");
  if (!existsSync(config.terminalLauncherPath) || readFileSync(config.terminalLauncherPath, "utf8") !== launcher) {
    writeAtomic(config.terminalLauncherPath, launcher, 0o600);
  }

  const integration = renderZshIntegration(config);
  if (!existsSync(config.shellIntegrationPath) || readFileSync(config.shellIntegrationPath, "utf8") !== integration) {
    writeAtomic(config.shellIntegrationPath, integration, 0o600);
  }

  const source = readTextFile(config.zshrcPath);
  if (source.existed && !existsSync(config.zshrcBackupPath)) {
    writeAtomic(config.zshrcBackupPath, source.text, 0o600);
  }
  const managedBlock = `${ZSHRC_START}\nif [[ -r ${shellQuote(config.shellIntegrationPath)} ]]; then\n  source ${shellQuote(config.shellIntegrationPath)}\nfi\n${ZSHRC_END}`;
  const next = replaceManagedBlock(source.text, managedBlock);
  const changed = next !== source.text;
  if (changed) writeUserShellFile(config.zshrcPath, next, source.mode);

  return {
    zshrcPath: config.zshrcPath,
    integrationPath: config.shellIntegrationPath,
    activationCommand: shellActivationCommand(config),
    changed,
    activeInCurrentShell:
      environment.CLAUDE_CODEX_SHELL_INTEGRATION === "1" &&
      typeof environment.CLAUDE_CODEX_STATE_DIR === "string" &&
      samePath(environment.CLAUDE_CODEX_STATE_DIR, config.stateDir),
  };
}

export function shellActivationCommand(config) {
  return `source ${shellQuote(config.shellIntegrationPath)} && claude`;
}

export function restoreLegacyGlobalMode(config) {
  const legacyStateExists = existsSync(config.legacyGlobalModeStatePath);
  const state = readJson(config.legacyGlobalModeStatePath);
  let result;
  if (state && validLegacyState(state)) {
    result = restoreLegacyState(config, state);
  } else {
    result = cleanLegacyGlobalSettings(config);
    if (legacyStateExists) {
      const quarantinedPath = `${config.legacyGlobalModeStatePath}.invalid-${Date.now()}`;
      renameSync(config.legacyGlobalModeStatePath, quarantinedPath);
      result = { ...result, quarantinedPath };
    }
  }
  removeLegacyResumeArtifacts(config);
  return result;
}

function restoreLegacyState(config, state) {
  const source = readClaudeSettings(config.claudeUserSettingsPath);
  const next = { ...source.value };
  const conflicts = [];
  for (const [name, snapshot] of Object.entries(state.original.topLevel)) {
    const current = snapshotProperty(next, name);
    const managed = state.managed.topLevel[name];
    const owned = current.present && (
      valuesEqual(current.value, managed) ||
      (name === "model" && isCodexGatewayModel(current.value)) ||
      (name === "availableModels" && isCodexModelList(current.value))
    );
    if (owned) restoreProperty(next, name, snapshot);
    else if (current.present || snapshot.present) conflicts.push(name);
  }

  const env = isPlainObject(next.env) ? { ...next.env } : {};
  for (const [name, snapshot] of Object.entries(state.original.env)) {
    const current = snapshotProperty(env, name);
    const managed = state.managed.env[name];
    const owned = current.present && (
      valuesEqual(current.value, managed) || isLegacyManagedEnvironment(name, current.value, config)
    );
    if (owned) restoreProperty(env, name, snapshot);
    else if (current.present || snapshot.present) conflicts.push(`env.${name}`);
  }
  if (Object.keys(env).length || state.original.envExisted) next.env = env;
  else delete next.env;

  if (!state.original.settingsFileExisted && Object.keys(next).length === 0) {
    rmSync(config.claudeUserSettingsPath, { force: true });
  } else {
    writeAtomic(
      config.claudeUserSettingsPath,
      `${JSON.stringify(next, null, 2)}\n`,
      state.original.settingsFileMode ?? 0o600,
    );
  }
  rmSync(config.legacyGlobalModeStatePath, { force: true });
  return { restored: true, cleaned: true, conflicts };
}

function cleanLegacyGlobalSettings(config) {
  const source = readClaudeSettings(config.claudeUserSettingsPath);
  const next = { ...source.value };
  const env = isPlainObject(next.env) ? { ...next.env } : {};
  const signal = isCodexGatewayModel(next.model) || isCodexModelList(next.availableModels) ||
    env.CLAUDE_CODEX_ACTIVE === "1" || env.ANTHROPIC_BASE_URL === config.gatewayBaseUrl;
  if (!signal) return { restored: false, cleaned: false, conflicts: [] };

  if (isCodexGatewayModel(next.model)) delete next.model;
  if (isCodexModelList(next.availableModels)) {
    delete next.availableModels;
    if (next.enforceAvailableModels === true) delete next.enforceAvailableModels;
  }
  for (const name of Object.keys(env)) {
    if (name.startsWith("CLAUDE_CODEX_")) delete env[name];
  }
  if (env.ANTHROPIC_BASE_URL === config.gatewayBaseUrl) delete env.ANTHROPIC_BASE_URL;
  if (isLocalProxyKey(config, env.ANTHROPIC_AUTH_TOKEN)) delete env.ANTHROPIC_AUTH_TOKEN;
  if (/^\s*x-(?:claude-codex-model|cc-codex-(?:session|fast))\s*:/im.test(
    String(env.ANTHROPIC_CUSTOM_HEADERS ?? ""),
  )) {
    const remaining = String(env.ANTHROPIC_CUSTOM_HEADERS)
      .split("\n")
      .filter((line) => !/^\s*x-(?:claude-codex-model|cc-codex-(?:session|fast))\s*:/i.test(line))
      .filter((line) => line.trim());
    if (remaining.length) env.ANTHROPIC_CUSTOM_HEADERS = remaining.join("\n");
    else delete env.ANTHROPIC_CUSTOM_HEADERS;
  }
  for (const name of CLAUDE_PROVIDER_ENV_KEYS) {
    if (env[name] === "") delete env[name];
  }
  if (env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === "") {
    delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  }
  if (env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === "1") {
    delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
  }
  if (env.CLAUDE_CODE_SUBAGENT_MODEL === "inherit") delete env.CLAUDE_CODE_SUBAGENT_MODEL;
  if (Object.keys(env).length) next.env = env;
  else delete next.env;
  writeAtomic(config.claudeUserSettingsPath, `${JSON.stringify(next, null, 2)}\n`, source.mode);
  return { restored: false, cleaned: true, conflicts: [] };
}

function updateRecordModel(record, model) {
  if (!isCodexGatewayModel(model)) return { ...record };
  const selectedModelId = decodeGatewayModelAlias(model);
  if (!selectedModelId) return { ...record };
  return {
    ...record,
    proxyModelId: model,
    selectedModelId,
    selectedModelDisplayName: selectedModelId,
    fastMode: record.fastMode === true && Array.isArray(record.fastModelIds) &&
      record.fastModelIds.includes(selectedModelId),
  };
}

function writeSettingsForMode(config, record) {
  const settings = renderClaudeCodexSettings(
    config,
    record.proxyModelId,
    record.availableModels,
    { sessionId: record.sessionId },
  );
  writeAtomic(record.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
}

function removeRoutesForSession(config, sessionId) {
  ensureState(config);
  for (const name of readdirSync(config.terminalRoutesDir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(config.terminalRoutesDir, name);
    const route = readJson(path);
    if (route?.sessionId === sessionId) rmSync(path, { force: true });
  }
}

function removeSessionMode(config, sessionId) {
  rmSync(sessionModePath(config, sessionId), { force: true });
  rmSync(sessionSettingsPath(config, sessionId), { force: true });
}

function removeRouteAndOrphanedMode(config, route, routePath) {
  rmSync(routePath, { force: true });
  const referencedElsewhere = readdirSync(config.terminalRoutesDir).some((name) => {
    if (!name.endsWith(".json")) return false;
    return readJson(join(config.terminalRoutesDir, name))?.sessionId === route.sessionId;
  });
  if (!referencedElsewhere) removeSessionMode(config, route.sessionId);
}

function validTerminalRoute(route) {
  return route?.version === ROUTE_VERSION && /^[a-f0-9]{64}$/.test(String(route.key ?? "")) &&
    validSessionId(route.sessionId) && Number.isInteger(route.terminal?.shellPid) &&
    typeof route.terminal?.tty === "string" && typeof route.cwd === "string";
}

function validSessionMode(record) {
  return record?.version === MODE_VERSION && validSessionId(record.sessionId) &&
    typeof record.cwd === "string" && typeof record.proxyModelId === "string" &&
    isCodexGatewayModel(record.proxyModelId) && Array.isArray(record.availableModels) &&
    typeof record.settingsPath === "string" && /^[a-f0-9]{64}$/.test(String(record.terminal?.key ?? ""));
}

function validSessionId(sessionId) {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(sessionId ?? ""));
}

function terminalIsAlive(terminal) {
  try {
    process.kill(terminal.shellPid, 0);
  } catch {
    return false;
  }
  const result = spawnSync("ps", ["-p", String(terminal.shellPid), "-o", "tty="], { encoding: "utf8" });
  if (result.status !== 0) return false;
  return String(result.stdout ?? "").trim().replace(/^\/dev\//, "") === terminal.tty;
}

function normalizePermissionMode(value) {
  const mode = String(value ?? "");
  return ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"].includes(mode)
    ? mode
    : null;
}

function lastAssistantModel(path) {
  if (!path || !existsSync(path)) return null;
  const file = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const length = Math.min(size, 2 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(file, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (size > length) lines.shift();
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const event = JSON.parse(lines[index]);
        if (event?.type === "assistant" && typeof event.message?.model === "string") {
          return event.message.model;
        }
      } catch {
        // Ignore partial and non-JSON transcript lines.
      }
    }
    return null;
  } finally {
    closeSync(file);
  }
}

function renderZshIntegration(config) {
  return `# Generated by CC Codex. Sourced from ~/.zshrc.\n` +
    `claude() {\n` +
    `  local _claude_codex_real="\${commands[claude]}"\n` +
    `  local _claude_codex_node="\${commands[node]}"\n` +
    `  if [[ -z "$_claude_codex_real" || -z "$_claude_codex_node" || ! -r ${shellQuote(config.terminalLauncherPath)} ]]; then\n` +
    `    if [[ -n "$_claude_codex_real" ]]; then\n` +
    `      command "$_claude_codex_real" "$@"\n` +
    `      return $?\n` +
    `    fi\n` +
    `    print -u2 -- "cc-codex: the real claude command was not found"\n` +
    `    return 127\n` +
    `  fi\n` +
    `  local _claude_codex_tty\n` +
    `  _claude_codex_tty="$(command tty 2>/dev/null)" || _claude_codex_tty=""\n` +
    `  CLAUDE_CODEX_REAL_CLAUDE="$_claude_codex_real" \\\n` +
    `  CLAUDE_CODEX_STATE_DIR=${shellQuote(config.stateDir)} \\\n` +
    `  CLAUDE_CODEX_SHELL_PID="$$" \\\n` +
    `  CLAUDE_CODEX_TTY="$_claude_codex_tty" \\\n` +
    `  CLAUDE_CODEX_SHELL_INTEGRATION=1 \\\n` +
    `    command "$_claude_codex_node" ${shellQuote(config.terminalLauncherPath)} "$@"\n` +
    `}\n`;
}

function replaceManagedBlock(text, managedBlock) {
  const withoutLegacy = removeManagedBlock(text, LEGACY_ZSHRC_START, LEGACY_ZSHRC_END);
  const start = withoutLegacy.indexOf(ZSHRC_START);
  const end = withoutLegacy.indexOf(ZSHRC_END);
  if (start >= 0 && end >= start) {
    const after = end + ZSHRC_END.length;
    return `${withoutLegacy.slice(0, start)}${managedBlock}${withoutLegacy.slice(after)}`;
  }
  const prefix = withoutLegacy && !withoutLegacy.endsWith("\n")
    ? `${withoutLegacy}\n`
    : withoutLegacy;
  return `${prefix}${prefix ? "\n" : ""}${managedBlock}\n`;
}

function removeManagedBlock(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  if (start < 0 || end < start) return text;
  let suffix = text.slice(end + endMarker.length);
  const prefix = text.slice(0, start);
  if (prefix.endsWith("\n") && suffix.startsWith("\n")) suffix = suffix.slice(1);
  return `${prefix}${suffix}`;
}

function writeUserShellFile(path, contents, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let isSymlink = false;
  try {
    isSymlink = lstatSync(path).isSymbolicLink();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (isSymlink) writeFileSync(path, contents, { mode });
  else writeAtomic(path, contents, mode);
}

function readTextFile(path) {
  if (!existsSync(path)) return { existed: false, text: "", mode: 0o644 };
  return {
    existed: true,
    text: readFileSync(path, "utf8"),
    mode: statSync(path).mode & 0o777,
  };
}

function readClaudeSettings(path) {
  if (!existsSync(path)) return { existed: false, mode: 0o600, value: {} };
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new UserError(`Claude settings are not valid JSON: ${path}`);
  }
  if (!isPlainObject(value)) throw new UserError(`Claude settings must contain a JSON object: ${path}`);
  if (value.env !== undefined && !isPlainObject(value.env)) {
    throw new UserError(`Claude settings env must contain a JSON object: ${path}`);
  }
  return { existed: true, mode: statSync(path).mode & 0o777, value };
}

function validLegacyState(state) {
  return state?.version === 1 && state.enabled === true &&
    isPlainObject(state.original?.topLevel) && isPlainObject(state.original?.env) &&
    isPlainObject(state.managed?.topLevel) && isPlainObject(state.managed?.env);
}

function removeLegacyResumeArtifacts(config) {
  try {
    const helper = readFileSync(config.legacyResumeHelperPath, "utf8");
    if (helper.includes("# managed by claude-codex-mode")) rmSync(config.legacyResumeHelperPath, { force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  rmSync(config.legacyResumeStatePath, { force: true });
  rmSync(config.legacyHandoffsDir, { recursive: true, force: true });
}

function isLegacyManagedEnvironment(name, value, config) {
  if (name.startsWith("CLAUDE_CODEX_")) return true;
  if (name === "ANTHROPIC_BASE_URL") return value === config.gatewayBaseUrl;
  if (name === "ANTHROPIC_CUSTOM_HEADERS") {
    return /^\s*x-(?:claude-codex-model|cc-codex-(?:session|fast))\s*:/im.test(
      String(value ?? ""),
    );
  }
  if (name === "ANTHROPIC_AUTH_TOKEN") return isLocalProxyKey(config, value);
  return false;
}

function isLocalProxyKey(config, value) {
  try {
    return value === readFileSync(config.proxyKeyPath, "utf8").trim();
  } catch {
    return false;
  }
}

function snapshotProperty(object, name) {
  return Object.prototype.hasOwnProperty.call(object, name)
    ? { present: true, value: object[name] }
    : { present: false };
}

function restoreProperty(object, name, snapshot) {
  if (snapshot.present) object[name] = snapshot.value;
  else delete object[name];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isCodexGatewayModel(value) {
  return typeof value === "string" && value.startsWith(GATEWAY_MODEL_PREFIX);
}

function isCodexModelList(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isCodexGatewayModel);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function samePath(left, right) {
  try {
    return realpathSync(resolve(left)) === realpathSync(resolve(right));
  } catch {
    return resolve(left) === resolve(right);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

function writeAtomic(path, contents, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, contents, { mode });
  renameSync(temporary, path);
}
