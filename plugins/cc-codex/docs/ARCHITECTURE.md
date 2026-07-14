# Architecture

## Package

The repository is the `cc-codex` marketplace. Its source lives in `plugins/cc-codex`. The Claude plugin manifest remains named `codex`, which gives commands the `/codex:*` namespace.

```text
.claude-plugin/marketplace.json
README.md
plugins/cc-codex/
  .claude-plugin/plugin.json
  CHANGELOG.md
  commands/
  docs/
  hooks/
  lib/
  scripts/
```

The source and Claude's immutable plugin cache contain code only. All writable data lives under `${CLAUDE_PLUGIN_DATA}`.

## Authentication

The local Codex CLI login is the source credential:

```text
${CODEX_HOME:-~/.codex}/auth.json
```

On enable, usage, status, and service startup, the plugin checks that file. A valid ChatGPT login is converted into the flat credential shape CLIProxyAPI expects and written with mode `0600` under `${CLAUDE_PLUGIN_DATA}/cliproxy-auth/codex-local.json`.

The original Codex auth file is read-only from this plugin's perspective. `/codex:auth` runs the native `codex login` command and then imports the resulting local credential. If the local credential is absent, `/codex:enable` stops before creating a route or starting shared services.

## Hooks

- `UserPromptExpansion` handles `/codex:enable` and `/codex:disable` before the model responds, so routing state is changed deterministically.
- `SessionStart` starts or reuses the local services and registers a routed Claude process.
- `SessionEnd` unregisters the process and stops the shared services when no routed sessions remain.

`/codex:auth`, `/codex:usage`, and `/codex:status` are ordinary plugin commands that invoke `scripts/plugin-action.mjs`; they do not need lifecycle hooks.

## Why the next launch is routed

Claude chooses its provider when the process starts. A command hook cannot replace that provider in a process that is already running.

`/codex:enable` therefore records the current Claude session and terminal. The next ordinary `claude` command in that same shell receives private `--settings`, `--resume`, and a one-time Codex `--model` value.

```text
/codex:enable
  -> validate local Codex login
  -> start or reuse local services
  -> write session settings and terminal route
  -> refresh the zsh pass-through

exit Claude, then run claude
  -> match shell PID, TTY, cwd, and session
  -> resume that session through Codex
```

Any mismatch fails open to the real Claude executable. Explicit settings, model, session, print, background, worktree, safe-mode, and plugin-administration launches also bypass the route.

## Services

Routed sessions share three loopback-only processes:

- `127.0.0.1:18316` — Claude-compatible gateway.
- `127.0.0.1:18317` — pinned CLIProxyAPI protocol translator.
- `127.0.0.1:18318` — native Codex app-server for model discovery and usage.

Locks and health checks prevent duplicate startup. The final disabled and exited route stops idle services.

## State

- `cliproxy-auth/` — imported local Codex credential.
- `runtime/` — verified CLIProxyAPI binary.
- `terminal-routes/` — shell and TTY route records.
- `session-modes/` — private session settings and selected model.
- `shell/` — stable launcher and zsh integration.
- `sessions/` — live routed Claude process markers.

Directories use `0700`; private files use `0600`. Global Claude settings are not the mode switch.
