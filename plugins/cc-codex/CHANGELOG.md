# Changelog

## 0.8.1

- Reuses the local Codex login without asking users to authenticate twice.
- Runs `codex login` through `/codex:auth` only when the local login is missing.
- Routes only the enabled Claude conversation and terminal through Codex.
- Uses Claude's `/model` picker instead of a separate models command.
- Shows Codex subscription limits through `/codex:usage` and `/codex:status`.
