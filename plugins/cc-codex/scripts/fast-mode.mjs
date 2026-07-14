#!/usr/bin/env node

import { UserError, getConfig } from "../lib/core.mjs";
import { setSessionFastMode, updateSessionFromTranscript } from "../lib/mode.mjs";

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
  const argument = String(input.command_args ?? "").trim().toLowerCase();
  if (argument && (!/^(on|off|status)$/.test(argument) || /\s/.test(argument))) {
    throw new UserError("Usage: /codex:fast [on|off|status]");
  }

  const config = getConfig();
  if (input.transcript_path) {
    updateSessionFromTranscript(config, {
      sessionId: input.session_id,
      transcriptPath: input.transcript_path,
    });
  }
  const result = await setSessionFastMode(config, {
    sessionId: input.session_id,
    action: argument || "toggle",
  });

  if (!result.supported) {
    respond(`Codex Fast mode is unavailable for ${result.modelDisplayName}. Use /model to choose a supported model.`);
  } else if (result.action === "status") {
    respond(`Codex Fast mode is ${result.enabled ? "on" : "off"} for ${result.modelDisplayName}.`);
  } else if (result.enabled) {
    respond(
      `Codex Fast mode is on for ${result.modelDisplayName}. ` +
        "It applies to the next Codex request and consumes credits faster than Standard mode.",
    );
  } else {
    respond(`Codex Fast mode is off for ${result.modelDisplayName}. The next Codex request uses Standard mode.`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  respond(`CC Codex could not change Fast mode: ${message}`);
}
