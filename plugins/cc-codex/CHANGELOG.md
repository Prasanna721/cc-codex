# Changelog

## 0.9.1

- Prints one exact first-time relaunch command after `/codex:enable`; no `exec zsh` step.
- Warns inside Claude when a pending Codex route was bypassed and shows the exact recovery command.
- Surfaces startup failures and redacted service log tails instead of hiding them in log files.
- Detects stale CC Codex services from an older plugin data directory, reclaims them only when idle, and refuses when a live routed process exists even if its session marker is stale.
- Adds catalog-aware `/codex:fast [on|off|status]` for per-conversation Fast mode.
- Suppresses Claude's nonessential background model request in routed sessions.
- Adds redacted per-request timing traces and an isolated mock/live latency benchmark.

## 0.8.1

- Reuses the local Codex login without asking users to authenticate twice.
- Runs `codex login` through `/codex:auth` only when the local login is missing.
- Routes only the enabled Claude conversation and terminal through Codex.
- Uses Claude's `/model` picker instead of a separate models command.
- Shows Codex subscription limits through `/codex:usage` and `/codex:status`.
