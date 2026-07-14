#!/usr/bin/env node

import {
  UserError,
  getConfig,
} from "../lib/core.mjs";
import {
  deriveTerminalIdentity,
  prepareTerminalSessionMode,
} from "../lib/mode.mjs";

async function readHookInput() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 1024 * 1024) throw new UserError("Claude hook input exceeded 1 MiB");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UserError("Claude supplied invalid hook input");
  }
}

function respond(message) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptExpansion",
      additionalContext:
        "The CC Codex plugin generated the result below. Reply with that result only. Do not call tools.\n\n" +
        message,
    },
  })}\n`);
}

try {
  const input = await readHookInput();
  if (input.hook_event_name !== "UserPromptExpansion") {
    throw new UserError(`Unexpected hook event: ${input.hook_event_name ?? "missing"}`);
  }
  const argument = String(input.command_args ?? "").trim();
  if (/\s/.test(argument)) {
    throw new UserError("Usage: /codex:enable [MODEL]");
  }
  const enabled = await prepareTerminalSessionMode(getConfig(), {
    sessionId: input.session_id,
    cwd: input.cwd,
    permissionMode: input.permission_mode,
    requestedModel: argument && argument !== "default" ? argument : null,
    terminalIdentity: deriveTerminalIdentity({ claudePid: process.ppid }),
  });
  const model = `${enabled.selected.displayName ?? enabled.selected.id} (${enabled.selected.id})`;
  if (enabled.shell.activeInCurrentShell) {
    respond(
      `Codex is enabled only for this conversation in this terminal.\n\n` +
        `Model: ${model}\n\n` +
        "Press Ctrl+C twice to exit Claude, then run `claude` normally in this same terminal. " +
        "It will resume this conversation through Codex automatically.\n\n" +
        "Other terminals and Claude sessions are unchanged.",
    );
  } else {
    respond(
      `Codex is enabled only for this conversation in this terminal.\n\n` +
        `Model: ${model}\n\n` +
        "One-time setup: the terminal integration was added to your zsh configuration. " +
        "Press Ctrl+C twice to exit Claude, run `exec zsh` once in this same terminal, then run `claude` normally. " +
        "It will resume this conversation through Codex automatically.\n\n" +
        "After this one-time setup, the normal flow is simply: exit Claude, then run `claude`. " +
        "Other terminals and Claude sessions are unchanged.",
    );
  }
} catch (error) {
  const message = error instanceof UserError ? error.message : "Unexpected CC Codex setup failure";
  respond(`CC Codex could not be enabled: ${message}`);
}
