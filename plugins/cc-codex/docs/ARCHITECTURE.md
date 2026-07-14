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

- `UserPromptExpansion` handles `/codex:enable`, `/codex:disable`, and `/codex:fast` before the model responds, so routing state is changed deterministically.
- `SessionStart` starts or reuses the local services and registers a routed Claude process. On an unrouted launch, it checks for a pending route and displays the exact recovery command through `systemMessage`.
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

The first enable cannot modify the already-running parent shell. It therefore prints `source '<plugin-data>/shell/cc-codex.zsh' && claude`. That command loads only the CC Codex launcher and immediately resumes the routed conversation. Future zsh processes load it from the managed `~/.zshrc` block.

Any mismatch starts the real Claude executable and carries a reason into `SessionStart`, which warns when a pending route was expected. Explicit settings, model, session, print, background, worktree, safe-mode, and plugin-administration launches are intentional bypasses and remain quiet.

## Fast mode

`/codex:fast` stores a boolean in the current session-mode record. Each request carries a private session header to the gateway. The gateway removes that header, checks the live session record and model capability, and sends an internal Fast marker only for supported models. CLIProxyAPI converts that marker into `service_tier: priority` in the upstream Codex request. Toggling does not restart services or edit the user's Codex configuration.

## Services

Routed sessions share three loopback-only processes:

- `127.0.0.1:18316` — Claude-compatible gateway.
- `127.0.0.1:18317` — pinned CLIProxyAPI protocol translator.
- `127.0.0.1:18318` — native Codex app-server for model discovery and usage.

Locks and authenticated health checks prevent duplicate startup and detect a process using a stale private key. An idle CC Codex stack from an older plugin data directory is reclaimed; an active older session produces an actionable error instead. The final disabled and exited route stops idle services. Startup errors include a redacted tail of the service log in Claude.

## Request latency and tracing

A routed model request crosses these measured boundaries:

```text
Claude Code
  -> loopback gateway: buffer body and select the routed model
  -> CLIProxyAPI: translate Anthropic messages to the Codex protocol
  -> Codex API: inference and streamed response
  -> CLIProxyAPI: translate the Codex stream to Anthropic events
  -> loopback gateway
  -> Claude Code
```

Set `CLAUDE_CODEX_TRACE=1` before starting a routed session to write correlated JSONL events to `${CLAUDE_PLUGIN_DATA}/logs/request-trace.jsonl`. The trace records body-read time, model-preparation time, upstream headers, first upstream byte, first downstream byte, stream duration, byte counts, status, and total time. CLIProxyAPI's private usage queue adds per-upstream-attempt Codex transport TTFT, executor latency, token counts, reasoning effort, service tier, and failure state. Prompts, response content, request bodies, headers, and credentials are never recorded.

The development harness, `npm run benchmark:trace`, measures the gateway alone and the gateway plus translator against deterministic mock streams at 1 KiB, 100 KiB, and 1 MiB. `npm run benchmark:trace -- --real --real-runs 1` adds bounded live requests through the direct bridge, Claude's bare harness, Claude's normal safe-mode harness, and native `codex exec`.

Routed settings set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Claude's model catalog is already present in the private session settings, so this avoids background model calls without removing the routed models from `/model`.

## State

- `cliproxy-auth/` — imported local Codex credential.
- `runtime/` — verified CLIProxyAPI binary.
- `terminal-routes/` — shell and TTY route records.
- `session-modes/` — private session settings and selected model.
- `shell/` — stable launcher and zsh integration.
- `sessions/` — live routed Claude process markers.

Directories use `0700`; private files use `0600`. Global Claude settings are not the mode switch.
