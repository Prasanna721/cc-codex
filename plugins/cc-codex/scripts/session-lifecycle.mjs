#!/usr/bin/env node

import {
  ensureAppServer,
  ensureGateway,
  ensureProxy,
  getConfig,
  listSessions,
  registerSession,
  stopServices,
  unregisterSession,
} from "../lib/core.mjs";
import {
  installShellIntegration,
  listTerminalRoutes,
  markSessionStarted,
  pendingRouteNotice,
  deriveTerminalIdentity,
  restoreLegacyGlobalMode,
  updateSessionFromTranscript,
} from "../lib/mode.mjs";

async function main() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text);
  const config = getConfig();
  restoreLegacyGlobalMode(config);
  const shell = installShellIntegration(config);

  if (process.env.CLAUDE_CODEX_ACTIVE !== "1") {
    if (process.argv[2] !== "start") return;
    let terminalIdentity = null;
    try {
      terminalIdentity = deriveTerminalIdentity({ claudePid: process.ppid });
    } catch {
      // A plain Claude launch with no pending route should stay silent.
    }
    const notice = pendingRouteNotice(config, {
      terminalIdentity,
      cwd: input.cwd,
      shellIntegrationActive: shell.activeInCurrentShell,
      bypassReason: process.env.CLAUDE_CODEX_BYPASS_REASON ?? null,
    });
    if (notice) emitSystemMessage(notice);
    return;
  }

  if (process.argv[2] === "start") {
    // Authentication/proxy failure must happen before the app-server is
    // started so a failed launch cannot leave a partial service stack behind.
    await ensureProxy(config);
    await Promise.all([
      ensureGateway(config),
      ensureAppServer(config),
    ]);
    const mode = markSessionStarted(config, {
      sessionId: input.session_id,
      model: input.model,
    });
    if (!mode) process.exit(0);
    registerSession(config, {
      sessionId: input.session_id,
      claudePid: process.ppid,
      model: input.model ?? "unknown",
      source: input.source ?? "unknown",
      cwd: input.cwd,
      startedAt: new Date().toISOString(),
    });
  } else if (process.argv[2] === "end") {
    updateSessionFromTranscript(config, {
      sessionId: input.session_id,
      transcriptPath: input.transcript_path,
      model: input.model,
    });
    unregisterSession(config, { sessionId: input.session_id });
    if (!listTerminalRoutes(config).length && !listSessions(config).length) {
      await stopServices(config);
    }
  }
}

function emitSystemMessage(message) {
  process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  emitSystemMessage(`CC Codex startup failed:\n\n${message}`);
});
