#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLAUDE_SUBCOMMANDS = new Set([
  "agents",
  "auth",
  "auto-mode",
  "doctor",
  "gateway",
  "install",
  "mcp",
  "plugin",
  "plugins",
  "project",
  "setup-token",
  "ultrareview",
  "update",
  "upgrade",
]);

const PASS_THROUGH_FLAGS = new Set([
  "--bare",
  "--background",
  "--bg",
  "--continue",
  "-c",
  "--fork-session",
  "--from-pr",
  "--help",
  "-h",
  "--model",
  "--no-session-persistence",
  "--print",
  "-p",
  "--remote-control",
  "--safe-mode",
  "--session-id",
  "--settings",
  "--tmux",
  "--version",
  "-v",
  "--worktree",
  "-w",
]);

export function terminalKey(shellPid, tty) {
  const pid = Number(shellPid);
  const normalizedTty = String(tty ?? "").trim().replace(/^\/dev\//, "");
  if (!Number.isInteger(pid) || pid <= 1 || !normalizedTty || normalizedTty === "?") return null;
  return {
    shellPid: pid,
    tty: normalizedTty,
    key: createHash("sha256").update(`${pid}\0${normalizedTty}`).digest("hex"),
  };
}

export function buildLaunchPlan(args, environment = process.env, cwd = process.cwd()) {
  const passthrough = (reason) => ({ routed: false, reason, args: [...args] });
  if (environment.CLAUDE_CODEX_BYPASS === "1") return passthrough("bypass requested");
  const stateDir = environment.CLAUDE_CODEX_STATE_DIR;
  const terminal = terminalKey(environment.CLAUDE_CODEX_SHELL_PID, environment.CLAUDE_CODEX_TTY);
  if (!stateDir || !terminal) return passthrough("no terminal identity");

  const routePath = resolve(stateDir, "terminal-routes", `${terminal.key}.json`);
  const route = readJson(routePath);
  if (!validRoute(route, terminal)) return passthrough("no route");
  const modePath = resolve(stateDir, "session-modes", `${route.sessionId}.json`);
  const mode = readJson(modePath);
  if (!validMode(mode, route, stateDir)) {
    rmSync(routePath, { force: true });
    return passthrough("invalid route state");
  }
  if (!samePath(cwd, route.cwd) || !samePath(cwd, mode.cwd)) {
    return passthrough("working directory changed");
  }
  if (!existsSync(mode.settingsPath)) {
    rmSync(routePath, { force: true });
    return passthrough("session settings missing");
  }

  const explicitResume = resumeArgument(args);
  if (explicitResume.present && explicitResume.value !== mode.sessionId) {
    return passthrough("different resume target");
  }
  if (hasPassThroughArgument(args, explicitResume)) {
    return passthrough("explicit Claude launch mode");
  }

  // Claude restores the last assistant model from the transcript on resume.
  // Always make the routed Codex selection explicit so an older Claude model
  // cannot trigger its fallback warning and expose the private gateway alias.
  const injected = [
    "--settings", mode.settingsPath,
    "--model", mode.proxyModelId,
  ];
  if (!hasPermissionArgument(args)) {
    if (mode.permissionMode === "bypassPermissions") {
      injected.push("--dangerously-skip-permissions");
    } else if (mode.permissionMode) {
      injected.push("--permission-mode", mode.permissionMode);
    }
  }
  if (!explicitResume.present) injected.push("--resume", mode.sessionId);

  return {
    routed: true,
    args: [...injected, ...args],
    sessionId: mode.sessionId,
    terminalKey: terminal.key,
    stateDir: resolve(stateDir),
  };
}

export function buildFailOpenLaunchPlan(args, environment = process.env, cwd = undefined) {
  try {
    const launchCwd = cwd === undefined ? process.cwd() : cwd;
    return buildLaunchPlan(args, environment, launchCwd);
  } catch (error) {
    return {
      routed: false,
      reason: "route planning failed",
      args: [...args],
      routeError: error.message,
    };
  }
}

function hasPassThroughArgument(args, explicitResume) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--resume" || arg === "-r" || arg.startsWith("--resume=")) continue;
    if ([...PASS_THROUGH_FLAGS].some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
      return true;
    }
    if (CLAUDE_SUBCOMMANDS.has(arg)) return true;
  }
  return explicitResume.present && !explicitResume.value;
}

function resumeArgument(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--resume=")) {
      return { present: true, value: arg.slice("--resume=".length) || null };
    }
    if (arg === "--resume" || arg === "-r") {
      const next = args[index + 1];
      return { present: true, value: next && !next.startsWith("-") ? next : null };
    }
  }
  return { present: false, value: null };
}

function hasPermissionArgument(args) {
  return args.some((arg) =>
    arg === "--dangerously-skip-permissions" || arg === "--permission-mode" ||
    arg.startsWith("--permission-mode="),
  );
}

function validRoute(route, terminal) {
  return route?.version === 1 && route.key === terminal.key &&
    route.terminal?.shellPid === terminal.shellPid && route.terminal?.tty === terminal.tty &&
    validSessionId(route.sessionId) && typeof route.cwd === "string";
}

function validMode(mode, route, stateDir) {
  if (
    mode?.version !== 1 || mode.sessionId !== route.sessionId || mode.terminal?.key !== route.key ||
    typeof mode.cwd !== "string" || typeof mode.settingsPath !== "string" ||
    typeof mode.proxyModelId !== "string" || !mode.proxyModelId.startsWith("claude-codex-")
  ) return false;
  const expectedSettings = resolve(stateDir, "session-modes", `${mode.sessionId}.settings.json`);
  return samePath(mode.settingsPath, expectedSettings);
}

function validSessionId(sessionId) {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(sessionId ?? ""));
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function samePath(left, right) {
  try {
    return realpathSync(resolve(left)) === realpathSync(resolve(right));
  } catch {
    return resolve(left) === resolve(right);
  }
}

async function run() {
  const realClaude = process.env.CLAUDE_CODEX_REAL_CLAUDE;
  if (!realClaude) {
    process.stderr.write("cc-codex: the real claude executable was not provided\n");
    process.exitCode = 127;
    return;
  }
  const originalArgs = process.argv.slice(2);
  const plan = buildFailOpenLaunchPlan(originalArgs);
  // Route state is optional. A corrupt/unreadable route must never prevent
  // ordinary Claude from starting, but it must not fail silently either.
  if (plan.routeError) {
    process.stderr.write(`cc-codex: route check failed: ${plan.routeError}\n`);
  }
  const environment = { ...process.env };
  delete environment.CLAUDE_CODEX_BYPASS;
  if (plan.routed) {
    delete environment.CLAUDE_CODEX_BYPASS_REASON;
    Object.assign(environment, {
      CLAUDE_CODEX_ACTIVE: "1",
      CLAUDE_CODEX_ROUTED: "1",
      CLAUDE_CODEX_SESSION_ID: plan.sessionId,
      CLAUDE_CODEX_TERMINAL_KEY: plan.terminalKey,
      CLAUDE_CODEX_STATE_DIR: plan.stateDir,
    });
  } else {
    environment.CLAUDE_CODEX_BYPASS_REASON = plan.reason;
    delete environment.CLAUDE_CODEX_ACTIVE;
    delete environment.CLAUDE_CODEX_ROUTED;
    delete environment.CLAUDE_CODEX_SESSION_ID;
    delete environment.CLAUDE_CODEX_TERMINAL_KEY;
  }

  const child = spawn(realClaude, plan.args, { env: environment, stdio: "inherit" });
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    // Launcher and Claude share the foreground process group, so the terminal
    // already delivers each signal to both. Absorb it in the parent while the
    // child handles exactly one copy, then mirror the child's final status.
    const handler = () => {};
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const result = await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  for (const [signal, handler] of handlers) process.off(signal, handler);
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.code ?? 1;
}

if (isMainModule(process.argv[1])) {
  run().catch((error) => {
    process.stderr.write(`cc-codex: ${error.message}\n`);
    process.exitCode = 1;
  });
}

function isMainModule(argument) {
  if (!argument) return false;
  try {
    return realpathSync(resolve(argument)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(argument) === resolve(fileURLToPath(import.meta.url));
  }
}
