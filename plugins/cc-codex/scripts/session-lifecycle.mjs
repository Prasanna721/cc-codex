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
  restoreLegacyGlobalMode,
  updateSessionFromTranscript,
} from "../lib/mode.mjs";

let text = "";
for await (const chunk of process.stdin) text += chunk;

try {
  const input = JSON.parse(text);
  const config = getConfig();
  restoreLegacyGlobalMode(config);
  if (process.env.CLAUDE_CODEX_ACTIVE !== "1") process.exit(0);
  if (process.argv[2] === "start") {
    installShellIntegration(config);
    await Promise.all([
      ensureGateway(config),
      ensureProxy(config),
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
} catch (error) {
  process.stderr.write(`cc-codex session hook: ${error.message}\n`);
  process.exitCode = 1;
}
