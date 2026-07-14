import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  gatewayAliasForModel,
  getConfig,
  renderClaudeCodexSettings,
} from "../plugins/cc-codex/lib/core.mjs";
import {
  normalizeTerminalIdentity,
  sessionModePath,
  sessionSettingsPath,
  terminalRoutePath,
} from "../plugins/cc-codex/lib/mode.mjs";

const [stateDir, cwd, sessionId, shellPid, tty] = process.argv.slice(2);
const config = getConfig({
  stateDir,
  runtimeDir: join(stateDir, "runtime"),
  zshrcPath: join(stateDir, "test.zshrc"),
  codexHome: join(stateDir, "codex-home"),
  gatewayPort: 45416,
  proxyPort: 45417,
  appServerPort: 45418,
});
const terminal = normalizeTerminalIdentity({ shellPid, tty });
const model = gatewayAliasForModel("gpt-5.6-sol");
const settingsPath = sessionSettingsPath(config, sessionId);
const timestamp = "2026-07-14T00:00:00.000Z";
const record = {
  version: 1,
  sessionId,
  cwd,
  permissionMode: null,
  proxyModelId: model,
  selectedModelId: "gpt-5.6-sol",
  selectedModelDisplayName: "GPT-5.6 Sol",
  availableModels: [model],
  fastModelIds: ["gpt-5.6-sol", model],
  fastMode: false,
  settingsPath,
  terminal,
  forceModelOnNextLaunch: true,
  enabledAt: timestamp,
  updatedAt: timestamp,
};
writeFileSync(
  settingsPath,
  `${JSON.stringify(renderClaudeCodexSettings(config, model, [model], { sessionId }), null, 2)}\n`,
  { mode: 0o600 },
);
writeFileSync(sessionModePath(config, sessionId), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
writeFileSync(terminalRoutePath(config, terminal), `${JSON.stringify({
  version: 1,
  key: terminal.key,
  terminal,
  sessionId,
  cwd,
  createdAt: timestamp,
  updatedAt: timestamp,
}, null, 2)}\n`, { mode: 0o600 });
