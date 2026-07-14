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
      `CC Codex is enabled for this conversation.\n\n` +
        `Model: ${model}\n\n` +
        "Do these exact steps:\n" +
        "1. Press Ctrl+C twice to exit Claude.\n" +
        "2. Run:\n\n" +
        "```sh\nclaude\n```\n\n" +
        "Other terminals remain on normal Claude.",
    );
  } else {
    respond(
      `CC Codex is ready for this conversation.\n\n` +
        `Model: ${model}\n\n` +
        "REQUIRED FIRST-TIME STEP\n\n" +
        "1. Press Ctrl+C twice to exit Claude.\n" +
        "2. Run this exact command in the same terminal:\n\n" +
        `\`\`\`sh\n${enabled.shell.activationCommand}\n\`\`\`\n\n` +
        "Do not run plain `claude` first; that would start normal Claude. " +
        "The command above loads CC Codex and resumes this conversation.",
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  respond(`CC Codex could not be enabled: ${message}`);
}
