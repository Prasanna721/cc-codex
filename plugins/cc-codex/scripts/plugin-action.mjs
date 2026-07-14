#!/usr/bin/env node

import {
  UserError,
  ensureGateway,
  formatUsage,
  getConfig,
  getModelCatalog,
  getUsageSnapshot,
  runCodexLogin,
  serviceStatus,
  syncLocalCodexAuth,
} from "../lib/core.mjs";
import { sessionFastStatus, terminalModeStatus } from "../lib/mode.mjs";

const config = getConfig();

async function main(action) {
  switch (action) {
    case "auth":
      await authenticate();
      return;
    case "usage":
      await showUsage();
      return;
    case "status":
      await showStatus();
      return;
    default:
      throw new UserError("The Codex mode plugin invoked an unknown internal action.");
  }
}

async function authenticate() {
  const existing = syncLocalCodexAuth(config);
  if (existing.available) {
    process.stdout.write("Ready: using the local Codex login. No additional authentication is needed.\n");
    return;
  }
  process.stdout.write(
    "No local Codex login was found. Starting `codex login` now.\n\n",
  );
  await runCodexLogin(config);
  process.stdout.write("Ready: the local Codex login will be reused by this plugin.\n");
}

async function showUsage() {
  requireLocalCodexAuthentication();
  const snapshot = await getUsageSnapshot(config);
  process.stdout.write(`${formatUsage(snapshot)}\n`);
}

async function showStatus() {
  const localAuth = syncLocalCodexAuth(config);
  let models = [];
  let usage = null;
  let serviceError = null;

  if (localAuth.available) {
    try {
      const catalog = await getModelCatalog(config);
      await ensureGateway(config);
      models = catalog.native;
      usage = await getUsageSnapshot(config);
    } catch (error) {
      serviceError = error.message;
    }
  }

  const status = serviceStatus(config);
  const terminalMode = terminalModeStatus(config);
  const currentNativeModel = terminalMode.enabled
    ? models.find((model) =>
      model.id === terminalMode.mode.selectedModelId || model.model === terminalMode.mode.selectedModelId)
    : null;
  const mode = terminalMode.enabled
    ? {
      ...terminalMode,
      mode: {
        ...terminalMode.mode,
        selectedModelDisplayName:
          currentNativeModel?.displayName ?? terminalMode.mode.selectedModelDisplayName,
      },
    }
    : terminalMode;
  const sessionLines = status.sessions.length
    ? status.sessions.map(
      (session) => `  Claude PID ${session.claudePid ?? "unknown"}: launch model ${session.model} (${session.cwd})`,
    ).join("\n") + "\n"
    : "";
  const authentication = localAuth.available
    ? "local Codex login"
    : "required (run /codex:auth)";
  const fast = mode.enabled ? sessionFastStatus(mode.mode) : null;
  const fastMode = !fast
    ? "unavailable (enable Codex first)"
    : fast.supported
      ? fast.enabled ? "on" : "off"
      : "unavailable for the selected model";

  process.stdout.write(
    "CC Codex\n" +
      `This conversation: ${mode.enabled ? `Codex (${mode.mode.selectedModelDisplayName ?? mode.mode.selectedModelId})` : "normal Claude"}\n` +
      `Fast mode: ${fastMode}\n` +
      `Enabled terminal routes: ${mode.routeCount}\n` +
      `Authentication: ${authentication}\n` +
      `Claude gateway: ${status.gateway.running ? `running (PID ${status.gateway.pid})` : "stopped"}\n` +
      `CLIProxyAPI: ${status.proxy.running ? `running (PID ${status.proxy.pid})` : "stopped"}\n` +
      `Codex app-server: ${status.appServer.running ? `running (PID ${status.appServer.pid})` : "stopped"}\n` +
      `Active Claude sessions: ${status.sessions.length}\n` +
      sessionLines +
      `Live native models: ${models.length}\n` +
      (serviceError ? `Service error: ${serviceError}\n` : "") +
      (usage ? `\n${formatUsage(usage)}\n` : ""),
  );
}

function requireLocalCodexAuthentication() {
  if (!syncLocalCodexAuth(config).available) {
    throw new UserError(
      "Codex is not signed in on this machine. Run /codex:auth, then retry.",
    );
  }
}

main(process.argv[2]).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
