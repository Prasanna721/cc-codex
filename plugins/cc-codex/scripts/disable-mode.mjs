#!/usr/bin/env node

import { UserError, getConfig } from "../lib/core.mjs";
import { disableSessionMode } from "../lib/mode.mjs";

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
  if (String(input.command_args ?? "").trim()) {
    throw new UserError("Usage: /codex:disable");
  }
  const result = disableSessionMode(getConfig(), { sessionId: input.session_id });
  respond(
    result.wasEnabled
      ? "Codex is disabled for this conversation. The current process stays on Codex until it exits. " +
        "After exiting, ordinary `claude` in this terminal starts normal Claude. Other sessions are unchanged."
      : "Codex was not enabled for this conversation. Other sessions are unchanged.",
  );
} catch (error) {
  const message = error instanceof UserError ? error.message : "Unexpected CC Codex disable failure";
  respond(`CC Codex could not be disabled: ${message}`);
}
