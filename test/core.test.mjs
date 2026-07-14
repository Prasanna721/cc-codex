import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ROOT,
  buildClaudeCodexEnvironment,
  decodeClaudeModelId,
  decodeGatewayModelAlias,
  encodeClaudeModelId,
  ensureState,
  formatUsage,
  findLiveRoutedProcesses,
  gatewayAliasForModel,
  getConfig,
  indexPreferredProxyModels,
  renderClaudeCodexSettings,
  renderProxyConfig,
  resolveSelectedModel,
  startupFailureMessage,
  syncLocalCodexAuth,
} from "../plugins/cc-codex/lib/core.mjs";
import {
  FAST_REQUEST_HEADER,
  SESSION_REQUEST_HEADER,
  applySessionRoutingHeaders,
  fastModelIds,
  modelSupportsFast,
} from "../plugins/cc-codex/lib/fast.mjs";
import {
  disableSessionMode,
  installShellIntegration,
  markSessionStarted,
  normalizeTerminalIdentity,
  pendingRouteNotice,
  prepareTerminalSessionMode,
  readSessionMode,
  restoreLegacyGlobalMode,
  sessionFastStatus,
  sessionModePath,
  sessionSettingsPath,
  setSessionFastMode,
  shellActivationCommand,
  terminalRoutePath,
} from "../plugins/cc-codex/lib/mode.mjs";
import {
  buildFailOpenLaunchPlan,
  buildLaunchPlan,
  terminalKey,
} from "../plugins/cc-codex/scripts/terminal-launcher.mjs";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

test("Codex model IDs round-trip through Claude's discovery prefix", () => {
  for (const model of ["gpt-5.6-sol", "gpt-5.4-mini", "gpt-5.3-codex-spark"]) {
    const encoded = encodeClaudeModelId(model);
    assert.match(encoded, /^claude-/);
    assert.equal(decodeClaudeModelId(encoded), model);
  }
  assert.equal(encodeClaudeModelId("claude-sonnet-4"), "claude-sonnet-4");
});

test("gateway aliases remain distinct reversible Claude-prefixed IDs", () => {
  const aliases = ["gpt-5.6-sol", "gpt-5.4", "gpt-5.4-mini"].map(gatewayAliasForModel);
  assert.equal(new Set(aliases).size, 3);
  assert.ok(aliases.every((alias) => alias.startsWith("claude-codex-")));
  assert.equal(decodeGatewayModelAlias(aliases[0]), "gpt-5.6-sol");
});

test("state generation binds the proxy to loopback and protects its key", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-codex-"));
  try {
    const config = testConfig(root, 28416);
    const { key } = ensureState(config);
    const generated = readFileSync(config.proxyConfigPath, "utf8");
    assert.equal(key.length, 64);
    assert.match(generated, /host: "127\.0\.0\.1"/);
    assert.match(generated, /port: 28417/);
    assert.match(generated, new RegExp(key));
    assert.match(
      generated,
      /protocol: "codex"\n          headers:\n            X-CC-Codex-Fast: "1"\n      params:\n        service_tier: "priority"/,
    );
    assert.equal(generated, renderProxyConfig(config, key));
    assert.equal(statSync(config.proxyKeyPath).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trace mode enables the private CLIProxy timing queue without changing the default", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-codex-trace-config-"));
  try {
    const normal = testConfig(root, 28516);
    const traced = getConfig({
      stateDir: join(root, "trace-state"),
      runtimeDir: join(root, "trace-runtime"),
      gatewayPort: 28616,
      proxyPort: 28617,
      appServerPort: 28618,
      traceEnabled: true,
      tracePath: join(root, "trace-state", "custom-trace.jsonl"),
    });
    assert.match(renderProxyConfig(normal, "a".repeat(64)), /usage-statistics-enabled: false/);
    assert.match(renderProxyConfig(traced, "b".repeat(64)), /usage-statistics-enabled: true/);
    assert.equal(traced.traceEnabled, true);
    assert.equal(traced.tracePath, join(root, "trace-state", "custom-trace.jsonl"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enable suggests /codex:auth when the local Codex login is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-codex-no-auth-"));
  try {
    const config = testConfig(root, 28916);
    const terminal = normalizeTerminalIdentity({ shellPid: process.pid, tty: "ttys-test" });
    await assert.rejects(
      prepareTerminalSessionMode(config, {
        sessionId: SESSION_A,
        cwd: root,
        terminalIdentity: terminal,
      }),
      /Run \/codex:auth, then retry \/codex:enable/,
    );
    assert.deepEqual(readdirSync(config.terminalRoutesDir), []);
    assert.deepEqual(readdirSync(config.sessionModesDir), []);
    assert.equal(existsSync(config.zshrcPath), false);
    assert.equal(existsSync(config.gatewayPidPath), false);
    assert.equal(existsSync(config.proxyPidPath), false);
    assert.equal(existsSync(config.appServerPidPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin commands use private scripts and leave model selection to /model", () => {
  for (const action of ["auth", "usage", "status"]) {
    const command = readFileSync(join(ROOT, "commands", `${action}.md`), "utf8");
    assert.match(command, new RegExp(`scripts/plugin-action\\.mjs\" ${action}`));
    assert.doesNotMatch(command, /bin\/claude-codex/);
  }
  assert.equal(existsSync(join(ROOT, "commands", "enable.md")), true);
  assert.equal(existsSync(join(ROOT, "commands", "disable.md")), true);
  assert.equal(existsSync(join(ROOT, "commands", "fast.md")), true);
  assert.equal(existsSync(join(ROOT, "scripts", "fast-mode.mjs")), true);
  assert.equal(existsSync(join(ROOT, "commands", "models.md")), false);
  assert.equal(existsSync(join(ROOT, "skills", "models")), false);
  assert.equal(existsSync(join(ROOT, "bin", "claude-codex")), false);
  assert.equal(existsSync(join(ROOT, "lib", "cli.mjs")), false);
  assert.equal(existsSync(join(ROOT, "..", "..", "bin")), false);
  assert.equal(existsSync(join(ROOT, "..", "..", "src")), false);
  assert.equal(existsSync(join(ROOT, "..", "..", ".state")), false);
  assert.equal(existsSync(join(ROOT, "..", "..", ".runtime")), false);
  assert.equal(existsSync(join(ROOT, "..", "..", "README.md")), true);
  assert.equal(existsSync(join(ROOT, "CHANGELOG.md")), true);
  assert.equal(existsSync(join(ROOT, "docs", "ARCHITECTURE.md")), true);
});

test("local Codex login is imported without modifying the native auth file", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-codex-local-auth-"));
  try {
    const config = testConfig(root, 29116);
    mkdirSync(join(root, "codex-home"), { recursive: true });
    const idToken = fakeJwt({
      email: "person@example.com",
      exp: 2_000_000_000,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-123",
        chatgpt_plan_type: "pro",
      },
    });
    const source = `${JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        access_token: "local-access-token",
        refresh_token: "local-refresh-token",
        id_token: idToken,
        account_id: "account-123",
      },
      last_refresh: "2026-07-13T12:00:00.000Z",
    }, null, 2)}\n`;
    writeFileSync(config.localCodexAuthPath, source, { mode: 0o600 });

    const first = syncLocalCodexAuth(config);
    const second = syncLocalCodexAuth(config);
    const imported = JSON.parse(readFileSync(config.localProxyAuthPath, "utf8"));
    assert.deepEqual(first, { available: true, imported: true, planType: "pro" });
    assert.deepEqual(second, { available: true, imported: false, planType: "pro" });
    assert.equal(readFileSync(config.localCodexAuthPath, "utf8"), source);
    assert.equal(imported.type, "codex");
    assert.equal(imported.source, "local-codex-cli");
    assert.equal(imported.plan_type, "pro");
    assert.equal(imported.access_token, "local-access-token");
    assert.equal(imported.OPENAI_API_KEY, undefined);
    assert.equal(statSync(config.localProxyAuthPath).mode & 0o777, 0o600);

    imported.access_token = "proxy-refreshed-access-token";
    imported.last_refresh = "2026-07-14T12:00:00.000Z";
    writeFileSync(config.localProxyAuthPath, `${JSON.stringify(imported, null, 2)}\n`, { mode: 0o600 });
    assert.equal(syncLocalCodexAuth(config).imported, false);
    assert.equal(
      JSON.parse(readFileSync(config.localProxyAuthPath, "utf8")).access_token,
      "proxy-refreshed-access-token",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live gateway aliases win over compatibility aliases", () => {
  const rawId = "gpt-5.4-mini";
  const legacy = { id: encodeClaudeModelId(rawId), rawId };
  const gateway = { id: gatewayAliasForModel(rawId), rawId };
  assert.equal(indexPreferredProxyModels([gateway, legacy]).get(rawId), gateway);
  assert.equal(indexPreferredProxyModels([legacy, gateway]).get(rawId), gateway);
});

test("saved model resolution uses the live native/proxy intersection", () => {
  const catalog = {
    available: [
      {
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        isDefault: true,
        proxy: { id: gatewayAliasForModel("gpt-5.6-sol") },
      },
      {
        id: "gpt-5.4",
        model: "gpt-5.4",
        isDefault: false,
        proxy: { id: gatewayAliasForModel("gpt-5.4") },
      },
    ],
  };
  assert.equal(resolveSelectedModel(catalog).id, "gpt-5.6-sol");
  assert.equal(resolveSelectedModel(catalog, "gpt-5.4").id, "gpt-5.4");
  assert.equal(resolveSelectedModel(catalog, gatewayAliasForModel("gpt-5.4")).id, "gpt-5.4");
  assert.throws(() => resolveSelectedModel(catalog, "missing"), /not in the current/);
});

test("usage formatting matches Codex's 20-segment remaining-limit bars", () => {
  const output = formatUsage({
    account: { account: { type: "chatgpt", planType: "pro" } },
    rateLimits: {
      rateLimitsByLimitId: {
        codex: {
          limitName: null,
          primary: { usedPercent: 45, windowDurationMins: 300, resetsAt: 2_000_000_000 },
          secondary: { usedPercent: 30, windowDurationMins: 10_080, resetsAt: 2_000_000_000 },
        },
        spark: {
          limitName: "GPT-5.3-Codex-Spark",
          primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 2_000_000_000 },
          secondary: null,
        },
      },
      rateLimitResetCredits: { availableCount: 1 },
    },
    usage: { summary: { lifetimeTokens: 1234567, currentStreakDays: 3, longestStreakDays: 5 } },
    capturedAt: new Date(2_000_000_000 * 1000).toISOString(),
  });
  assert.match(output, /ChatGPT Pro/);
  assert.match(output, /5h limit:\s+\[███████████░░░░░░░░░\] 55% left \(resets \d{2}:\d{2}\)/);
  assert.match(output, /Weekly limit:\s+\[██████████████░░░░░░\] 70% left/);
  assert.match(output, /GPT-5\.3-Codex-Spark Weekly limit:\s+\[████████████████████\] 100% left/);
  assert.match(output, /1,234,567/);
});

test("per-session settings contain the gateway and private session header without touching user settings", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-codex-settings-"));
  try {
    const config = testConfig(root, 29416);
    const model = gatewayAliasForModel("gpt-5.4-mini");
    const settings = renderClaudeCodexSettings(config, model, [model], { sessionId: SESSION_A });
    assert.equal(settings.model, model);
    assert.deepEqual(settings.availableModels, [model]);
    assert.equal(settings.enforceAvailableModels, true);
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:29416");
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN.length, 64);
    assert.equal(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
    assert.equal(settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "");
    assert.equal(settings.env.CLAUDE_CODE_USE_BEDROCK, "");
    assert.equal(settings.env.CLAUDE_CODEX_STATE_DIR, config.stateDir);
    assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, new RegExp(`${SESSION_REQUEST_HEADER}: ${SESSION_A}`));
    const launchEnvironment = buildClaudeCodexEnvironment(config, model, {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    }, { sessionId: SESSION_A });
    assert.equal("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" in launchEnvironment, false);
    assert.equal(existsSync(config.claudeUserSettingsPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Fast mode follows the live model catalog and is applied per request", async () => {
  const root = mkdtempSync(join(tmpdir(), "cc-codex-fast-"));
  try {
    const config = testConfig(root, 29916);
    ensureState(config);
    const supportedAlias = gatewayAliasForModel("gpt-5.6-sol");
    const unsupportedAlias = gatewayAliasForModel("gpt-5.4-mini");
    const supported = {
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      serviceTiers: [{ id: "priority", displayName: "Fast" }],
      proxy: { id: supportedAlias },
    };
    const unsupported = {
      id: "gpt-5.4-mini",
      model: "gpt-5.4-mini",
      displayName: "GPT-5.4 mini",
      serviceTiers: [],
      proxy: { id: unsupportedAlias },
    };
    const catalog = { available: [supported, unsupported] };
    const ids = fastModelIds(catalog.available);
    assert.equal(modelSupportsFast(supported), true);
    assert.equal(modelSupportsFast(unsupported), false);
    assert.deepEqual(new Set(ids), new Set(["gpt-5.6-sol", supportedAlias]));

    const terminal = normalizeTerminalIdentity({ shellPid: 4040, tty: "ttys040" });
    writeMode(config, {
      sessionId: SESSION_A,
      terminal,
      model: supportedAlias,
      fastModelIds: ids,
    });
    const enabled = await setSessionFastMode(config, {
      sessionId: SESSION_A,
      action: "on",
      catalog,
    });
    assert.deepEqual(
      { enabled: enabled.enabled, supported: enabled.supported, changed: enabled.changed },
      { enabled: true, supported: true, changed: true },
    );
    assert.deepEqual(sessionFastStatus(readSessionMode(config, SESSION_A)), {
      supported: true,
      enabled: true,
    });

    const routedHeaders = applySessionRoutingHeaders({
      [SESSION_REQUEST_HEADER]: SESSION_A,
      [FAST_REQUEST_HEADER]: "malicious-client-value",
      "content-type": "application/json",
    }, config.stateDir, { modelId: supportedAlias });
    assert.equal(routedHeaders[SESSION_REQUEST_HEADER], undefined);
    assert.equal(routedHeaders[FAST_REQUEST_HEADER], "1");
    assert.equal(routedHeaders["content-type"], "application/json");

    const unsupportedHeaders = applySessionRoutingHeaders({
      [SESSION_REQUEST_HEADER]: SESSION_A,
    }, config.stateDir, { modelId: unsupportedAlias });
    assert.equal(unsupportedHeaders[FAST_REQUEST_HEADER], undefined);

    const status = await setSessionFastMode(config, {
      sessionId: SESSION_A,
      action: "status",
      catalog,
    });
    assert.equal(status.enabled, true);
    assert.equal(status.changed, false);
    const disabled = await setSessionFastMode(config, {
      sessionId: SESSION_A,
      action: "off",
      catalog,
    });
    assert.equal(disabled.enabled, false);

    writeMode(config, {
      sessionId: SESSION_B,
      terminal: normalizeTerminalIdentity({ shellPid: 4141, tty: "ttys041" }),
      model: unsupportedAlias,
      fastModelIds: ids,
    });
    await assert.rejects(
      setSessionFastMode(config, { sessionId: SESSION_B, action: "on", catalog }),
      /does not offer Codex Fast mode.*GPT-5\.6 Sol/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal launcher routes only the matching shell, cwd, and session", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-codex-route-"));
  try {
    const config = testConfig(root, 30416);
    ensureState(config);
    const terminal = normalizeTerminalIdentity({ shellPid: 4242, tty: "/dev/ttys042" });
    const model = gatewayAliasForModel("gpt-5.6-sol");
    writeMode(config, { sessionId: SESSION_A, terminal, model, permissionMode: "bypassPermissions" });
    const environment = {
      CLAUDE_CODEX_STATE_DIR: config.stateDir,
      CLAUDE_CODEX_SHELL_PID: "4242",
      CLAUDE_CODEX_TTY: "/dev/ttys042",
    };

    const routed = buildLaunchPlan([], environment, root);
    assert.equal(routed.routed, true);
    assert.deepEqual(routed.args, [
      "--settings", sessionSettingsPath(config, SESSION_A),
      "--model", model,
      "--dangerously-skip-permissions",
      "--resume", SESSION_A,
    ]);
    assert.equal(buildLaunchPlan([], { ...environment, CLAUDE_CODEX_TTY: "ttys043" }, root).routed, false);
    assert.equal(buildLaunchPlan([], environment, join(root, "elsewhere")).routed, false);
    assert.equal(buildLaunchPlan(["plugin", "list"], environment, root).routed, false);
    assert.equal(buildLaunchPlan(["--model", "haiku"], environment, root).routed, false);
    assert.equal(buildLaunchPlan(["--resume", SESSION_B], environment, root).routed, false);
    assert.equal(buildLaunchPlan([], { ...environment, CLAUDE_CODEX_BYPASS: "1" }, root).routed, false);
    const failOpen = buildFailOpenLaunchPlan(["--dangerously-skip-permissions"], environment, null);
    assert.equal(failOpen.routed, false);
    assert.deepEqual(failOpen.args, ["--dangerously-skip-permissions"]);
    assert.match(failOpen.routeError, /path/i);
    const originalCwd = process.cwd;
    process.cwd = () => { throw new Error("current directory was deleted"); };
    try {
      const deletedCwd = buildFailOpenLaunchPlan([], environment);
      assert.equal(deletedCwd.routed, false);
      assert.match(deletedCwd.routeError, /directory was deleted/);
    } finally {
      process.cwd = originalCwd;
    }

    const matchingResume = buildLaunchPlan(["--resume", SESSION_A], environment, root);
    assert.equal(matchingResume.routed, true);
    assert.equal(matchingResume.args.filter((arg) => arg === "--resume").length, 1);
    assert.deepEqual(terminalKey(4242, "/dev/ttys042"), terminal);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending routes produce an exact recovery command instead of silently using Claude", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-codex-pending-route-"));
  try {
    const config = testConfig(root, 30916);
    ensureState(config);
    const terminal = normalizeTerminalIdentity({ shellPid: 4343, tty: "ttys043" });
    const model = gatewayAliasForModel("gpt-5.6-sol");
    writeMode(config, { sessionId: SESSION_A, terminal, model });

    const firstLaunch = pendingRouteNotice(config, {
      terminalIdentity: terminal,
      cwd: root,
      shellIntegrationActive: false,
    });
    assert.match(firstLaunch, /shell has not loaded the CC Codex launcher/);
    assert.match(firstLaunch, new RegExp(escapeRegExp(shellActivationCommand(config))));

    const wrongDirectory = pendingRouteNotice(config, {
      terminalIdentity: terminal,
      cwd: join(root, "elsewhere"),
      shellIntegrationActive: true,
      bypassReason: "working directory changed",
    });
    assert.match(wrongDirectory, new RegExp(escapeRegExp(`cd '${root}' && claude`)));
    assert.equal(pendingRouteNotice(config, {
      terminalIdentity: terminal,
      cwd: root,
      shellIntegrationActive: true,
      bypassReason: "explicit Claude launch mode",
    }), null);

    rmSync(sessionSettingsPath(config, SESSION_A));
    const plan = buildLaunchPlan([], {
      CLAUDE_CODEX_STATE_DIR: config.stateDir,
      CLAUDE_CODEX_SHELL_PID: String(terminal.shellPid),
      CLAUDE_CODEX_TTY: terminal.tty,
    }, root);
    assert.equal(plan.reason, "session settings missing");
    assert.match(pendingRouteNotice(config, {
      terminalIdentity: terminal,
      cwd: root,
      shellIntegrationActive: true,
      bypassReason: plan.reason,
    }), /Run \/codex:enable again/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session start consumes the one-time model override and persists native model changes", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-codex-model-state-"));
  try {
    const config = testConfig(root, 31416);
    ensureState(config);
    const terminal = normalizeTerminalIdentity({ shellPid: 5252, tty: "ttys052" });
    const first = gatewayAliasForModel("gpt-5.6-sol");
    const second = gatewayAliasForModel("gpt-5.4");
    writeMode(config, { sessionId: SESSION_A, terminal, model: first });

    const updated = markSessionStarted(config, { sessionId: SESSION_A, model: second });
    assert.equal(updated.forceModelOnNextLaunch, false);
    assert.equal(updated.proxyModelId, second);
    assert.equal(updated.selectedModelId, "gpt-5.4");
    const settings = JSON.parse(readFileSync(sessionSettingsPath(config, SESSION_A), "utf8"));
    assert.equal(settings.model, second);
    assert.match(settings.env.ANTHROPIC_CUSTOM_HEADERS, new RegExp(second));
    const plan = buildLaunchPlan([], {
      CLAUDE_CODEX_STATE_DIR: config.stateDir,
      CLAUDE_CODEX_SHELL_PID: "5252",
      CLAUDE_CODEX_TTY: "ttys052",
    }, root);
    assert.equal(plan.routed, true);
    assert.equal(plan.args.includes("--model"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("disable removes only the current conversation route", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-codex-disable-"));
  try {
    const config = testConfig(root, 32416);
    ensureState(config);
    writeMode(config, {
      sessionId: SESSION_A,
      terminal: normalizeTerminalIdentity({ shellPid: 6161, tty: "ttys061" }),
      model: gatewayAliasForModel("gpt-5.6-sol"),
    });
    writeMode(config, {
      sessionId: SESSION_B,
      terminal: normalizeTerminalIdentity({ shellPid: 6262, tty: "ttys062" }),
      model: gatewayAliasForModel("gpt-5.4"),
    });

    const result = disableSessionMode(config, { sessionId: SESSION_A });
    assert.equal(result.wasEnabled, true);
    assert.equal(readSessionMode(config, SESSION_A), null);
    assert.equal(existsSync(sessionSettingsPath(config, SESSION_A)), false);
    assert.ok(readSessionMode(config, SESSION_B));
    assert.equal(existsSync(sessionSettingsPath(config, SESSION_B)), true);
    assert.equal(existsSync(terminalRoutePath(config, { shellPid: 6262, tty: "ttys062" })), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell integration preserves zshrc, migrates the old marker, and stays idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-codex-shell-"));
  try {
    const config = testConfig(root, 33416);
    mkdirSync(join(root, "home"), { recursive: true });
    const originalZshrc =
      "export KEEP_ME=yes\n\n" +
      "# >>> claude-codex-mode >>>\nsource /tmp/old-claude-codex.zsh\n# <<< claude-codex-mode <<<\n";
    writeFileSync(config.zshrcPath, originalZshrc, { mode: 0o644 });
    const first = installShellIntegration(config, { environment: {} });
    const second = installShellIntegration(config, { environment: {} });
    const staleLauncher = installShellIntegration(config, {
      environment: {
        CLAUDE_CODEX_SHELL_INTEGRATION: "1",
        CLAUDE_CODEX_STATE_DIR: join(root, "old-plugin-data"),
      },
    });
    const currentLauncher = installShellIntegration(config, {
      environment: {
        CLAUDE_CODEX_SHELL_INTEGRATION: "1",
        CLAUDE_CODEX_STATE_DIR: config.stateDir,
      },
    });
    const zshrc = readFileSync(config.zshrcPath, "utf8");
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(staleLauncher.activeInCurrentShell, false);
    assert.equal(currentLauncher.activeInCurrentShell, true);
    assert.match(zshrc, /export KEEP_ME=yes/);
    assert.equal((zshrc.match(/>>> cc-codex/g) ?? []).length, 1);
    assert.equal((zshrc.match(/>>> claude-codex-mode/g) ?? []).length, 0);
    assert.match(readFileSync(config.shellIntegrationPath, "utf8"), /claude\(\)/);
    assert.match(readFileSync(config.shellIntegrationPath, "utf8"), /commands\[claude\]/);
    assert.equal(readFileSync(config.zshrcBackupPath, "utf8"), originalZshrc);
    assert.equal(statSync(config.zshrcPath).mode & 0o777, 0o644);
    assert.equal(spawnSync("zsh", ["-n", config.shellIntegrationPath]).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the first-enable copy command routes the same terminal while plain claude does not", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-codex-first-enable-"));
  try {
    const config = testConfig(root, 33916);
    mkdirSync(join(root, "bin"), { recursive: true });
    const fakeClaude = join(root, "bin", "claude");
    writeFileSync(
      fakeClaude,
      "#!/bin/sh\n" +
        "printf 'FAKE_ACTIVE=%s\\n' \"${CLAUDE_CODEX_ACTIVE:-}\"\n" +
        "for arg in \"$@\"; do printf 'FAKE_ARG=%s\\n' \"$arg\"; done\n",
      { mode: 0o755 },
    );
    chmodSync(fakeClaude, 0o755);
    const fakeTty = join(root, "bin", "tty");
    writeFileSync(fakeTty, "#!/bin/sh\nprintf '/dev/ttys-cc-codex-test\\n'\n", { mode: 0o755 });
    chmodSync(fakeTty, 0o755);
    const shell = installShellIntegration(config, { environment: {} });
    const fixture = join(ROOT, "..", "..", "test-fixtures", "prepare-shell-route.mjs");
    const command = [
      "unset CLAUDE_CODEX_ACTIVE CLAUDE_CODEX_ROUTED CLAUDE_CODEX_SESSION_ID CLAUDE_CODEX_TERMINAL_KEY",
      `export PATH=${shellQuoteForTest(join(root, "bin"))}:$PATH`,
      `${shellQuoteForTest(process.execPath)} ${shellQuoteForTest(fixture)} ` +
        `${shellQuoteForTest(config.stateDir)} ${shellQuoteForTest(root)} ${SESSION_A} "$$" "$(tty)"`,
      "printf 'PLAIN\\n'",
      "claude",
      "printf 'ACTIVATED\\n'",
      shell.activationCommand,
    ].join("\n");
    const result = spawnSync("/bin/zsh", ["-f", "-c", command], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const output = result.stdout.replaceAll("\r", "");
    const plain = output.slice(output.indexOf("PLAIN\n"), output.indexOf("ACTIVATED\n"));
    const activated = output.slice(output.indexOf("ACTIVATED\n"));
    assert.match(plain, /FAKE_ACTIVE=\n/);
    assert.doesNotMatch(plain, /FAKE_ARG=--settings/);
    assert.match(activated, /FAKE_ACTIVE=1\n/, result.stderr);
    assert.match(activated, /FAKE_ARG=--settings\n/);
    assert.match(activated, new RegExp(escapeRegExp(sessionSettingsPath(config, SESSION_A))));
    assert.match(activated, /FAKE_ARG=--resume\n/);
    assert.match(activated, new RegExp(SESSION_A));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SessionStart warns when a pending route was launched without loading the shell integration", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-codex-session-warning-"));
  try {
    const config = testConfig(root, 34116);
    ensureState(config);
    const terminal = normalizeTerminalIdentity({ shellPid: 4545, tty: "ttys045" });
    writeMode(config, {
      sessionId: SESSION_A,
      terminal,
      model: gatewayAliasForModel("gpt-5.6-sol"),
    });
    const result = runSessionHook(config, {
      input: {
        session_id: SESSION_A,
        hook_event_name: "SessionStart",
        source: "resume",
        cwd: root,
      },
      environment: {
        CLAUDE_CODEX_SHELL_PID: String(terminal.shellPid),
        CLAUDE_CODEX_TTY: terminal.tty,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout.trim());
    assert.match(response.systemMessage, /has not loaded the CC Codex launcher/);
    assert.match(response.systemMessage, new RegExp(escapeRegExp(shellActivationCommand(config))));
    assert.equal(existsSync(config.proxyPidPath), false);
    assert.equal(existsSync(config.gatewayPidPath), false);
    assert.equal(existsSync(config.appServerPidPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SessionStart surfaces missing authentication inline without starting a partial stack", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-codex-session-auth-error-"));
  try {
    const config = testConfig(root, 34316);
    const result = runSessionHook(config, {
      input: {
        session_id: SESSION_A,
        hook_event_name: "SessionStart",
        source: "resume",
        cwd: root,
      },
      environment: { CLAUDE_CODEX_ACTIVE: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout.trim());
    assert.match(response.systemMessage, /^CC Codex startup failed:/);
    assert.match(response.systemMessage, /Run \/codex:auth, then retry/);
    assert.equal(existsSync(config.proxyPidPath), false);
    assert.equal(existsSync(config.gatewayPidPath), false);
    assert.equal(existsSync(config.appServerPidPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup failures include a redacted log tail and its exact path", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-codex-startup-log-"));
  try {
    const logPath = join(root, "service.log");
    writeFileSync(
      logPath,
      Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n") +
        "\nBearer secret-token\nsk-example1234567890\n" +
        "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.signature\nlast-visible-line\n",
    );
    const message = startupFailureMessage(new Error("service exited"), logPath);
    assert.match(message, /service exited/);
    assert.match(message, /Last startup output:/);
    assert.match(message, /last-visible-line/);
    assert.match(message, new RegExp(escapeRegExp(logPath)));
    assert.doesNotMatch(message, /secret-token|sk-example1234567890|eyJhbGciOiJub25l/);
    assert.match(message, /\[redacted\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale service cleanup detects live routed processes even when session markers are missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "cc-codex-live-process-"));
  const marker = join(root, "session-modes", `${SESSION_A}.settings.json`);
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", marker],
    { stdio: "ignore" },
  );
  try {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    const matches = findLiveRoutedProcesses(root);
    assert.ok(matches.some((record) => record.pid === child.pid));
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => {
      child.once("exit", resolvePromise);
      setTimeout(resolvePromise, 1_000);
    });
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy global mode is restored exactly during migration", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-codex-legacy-"));
  try {
    const config = testConfig(root, 34416);
    ensureState(config);
    mkdirSync(join(root, "home", ".claude"), { recursive: true });
    const model = gatewayAliasForModel("gpt-5.6-sol");
    const original = { theme: "dark", model: "haiku", env: { KEEP_ME: "yes" } };
    const active = {
      theme: "dark",
      model,
      availableModels: [model],
      enforceAvailableModels: true,
      env: { KEEP_ME: "yes", ANTHROPIC_BASE_URL: config.gatewayBaseUrl },
    };
    writeFileSync(config.claudeUserSettingsPath, `${JSON.stringify(active, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(config.legacyGlobalModeStatePath, `${JSON.stringify({
      version: 1,
      enabled: true,
      original: {
        settingsFileExisted: true,
        settingsFileMode: 0o644,
        envExisted: true,
        topLevel: {
          model: { present: true, value: "haiku" },
          availableModels: { present: false },
          enforceAvailableModels: { present: false },
        },
        env: { ANTHROPIC_BASE_URL: { present: false } },
      },
      managed: {
        topLevel: { model, availableModels: [model], enforceAvailableModels: true },
        env: { ANTHROPIC_BASE_URL: config.gatewayBaseUrl },
      },
    }, null, 2)}\n`);

    const result = restoreLegacyGlobalMode(config);
    assert.equal(result.restored, true);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(JSON.parse(readFileSync(config.claudeUserSettingsPath, "utf8")), original);
    assert.equal(statSync(config.claudeUserSettingsPath).mode & 0o777, 0o644);
    assert.equal(existsSync(config.legacyGlobalModeStatePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed legacy global state is quarantined once", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-codex-malformed-legacy-"));
  try {
    const config = testConfig(root, 35416);
    ensureState(config);
    writeFileSync(config.legacyGlobalModeStatePath, "{not-json\n", { mode: 0o600 });
    const first = restoreLegacyGlobalMode(config);
    assert.equal(existsSync(config.legacyGlobalModeStatePath), false);
    assert.ok(first.quarantinedPath);
    assert.equal(existsSync(first.quarantinedPath), true);
    assert.equal(
      readdirSync(config.stateDir).filter((name) => name.startsWith("persistent-mode.json.invalid-")).length,
      1,
    );
    const second = restoreLegacyGlobalMode(config);
    assert.equal(second.quarantinedPath, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeMode(config, {
  sessionId,
  terminal,
  model,
  permissionMode = null,
  fastMode = false,
  fastModelIds: supportedFastModels = [],
} = {}) {
  const settingsPath = sessionSettingsPath(config, sessionId);
  const record = {
    version: 1,
    sessionId,
    cwd: config.testRoot,
    permissionMode,
    proxyModelId: model,
    selectedModelId: decodeGatewayModelAlias(model),
    selectedModelDisplayName: decodeGatewayModelAlias(model),
    availableModels: [model, gatewayAliasForModel("gpt-5.4")],
    fastModelIds: supportedFastModels,
    fastMode,
    settingsPath,
    terminal,
    forceModelOnNextLaunch: true,
    enabledAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
  writeFileSync(
    settingsPath,
    `${JSON.stringify(renderClaudeCodexSettings(config, model, record.availableModels, { sessionId }), null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(sessionModePath(config, sessionId), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(terminalRoutePath(config, terminal), `${JSON.stringify({
    version: 1,
    key: terminal.key,
    terminal,
    sessionId,
    cwd: record.cwd,
    createdAt: record.enabledAt,
    updatedAt: record.updatedAt,
  }, null, 2)}\n`, { mode: 0o600 });
  return record;
}

function fakeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.test-signature`;
}

function runSessionHook(config, { input, environment = {} }) {
  const home = join(config.testRoot, "home");
  mkdirSync(home, { recursive: true });
  return spawnSync(
    process.execPath,
    [join(ROOT, "scripts", "session-lifecycle.mjs"), "start"],
    {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: config.codexHome,
        CLAUDE_PLUGIN_DATA: config.stateDir,
        CLAUDE_CODEX_STATE_DIR: config.stateDir,
        CLAUDE_CODEX_RUNTIME_DIR: config.runtimeDir,
        CLAUDE_CODEX_GATEWAY_PORT: String(config.gatewayPort),
        CLAUDE_CODEX_PROXY_PORT: String(config.proxyPort),
        CLAUDE_CODEX_APP_SERVER_PORT: String(config.appServerPort),
        CLAUDE_CODEX_ZSHRC_PATH: config.zshrcPath,
        CLAUDE_CODEX_CLAUDE_SETTINGS_PATH: config.claudeUserSettingsPath,
        ...environment,
      },
    },
  );
}

function shellQuoteForTest(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function testConfig(root, gatewayPort) {
  const config = getConfig({
    stateDir: join(root, "state"),
    runtimeDir: join(root, "runtime"),
    claudeUserSettingsPath: join(root, "home", ".claude", "settings.json"),
    zshrcPath: join(root, "home", ".zshrc"),
    codexHome: join(root, "codex-home"),
    legacyResumeHelperPath: join(root, "bin", "codex-mode"),
    gatewayPort,
    proxyPort: gatewayPort + 1,
    appServerPort: gatewayPort + 2,
  });
  config.testRoot = root;
  return config;
}
