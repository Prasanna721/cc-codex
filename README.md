# CC Codex

Run a Claude Code conversation on Codex using your existing Codex subscription.

## Install

Add the marketplace from inside Claude Code:

```text
/plugin marketplace add <github-owner/repository-or-local-path>
```

Install the plugin and reload:

```text
/plugin install codex@cc-codex
/reload-plugins
```

The normal Codex CLI must be installed. CC Codex does not add another user-facing CLI.

## Use it

Start with:

```text
/codex:enable
```

CC Codex uses the login already held by the local Codex CLI. If Codex is not signed in, enable stops and tells you to run:

```text
/codex:auth
```

That command runs `codex login`. It is only needed when the local credential is missing.

After enable, exit Claude and run `claude` again in the same terminal. The conversation resumes on Codex. Other terminals keep using normal Claude.

The first enable adds a small block to `~/.zshrc`. Run `exec zsh` once after that first enable, then start `claude` again.

To choose a Codex model, use Claude's normal picker:

```text
/model
```

There is no separate models command.

## Commands

- `/codex:enable [MODEL]` — route this conversation through Codex on its next launch.
- `/codex:disable` — return this conversation to normal Claude after exit.
- `/codex:auth` — run local Codex login only when needed.
- `/codex:usage` — show Codex limits with the same remaining-usage bars as Codex `/status`.
- `/codex:status` — show the route, local login, and service state.

## What enable changes

Enable creates a private route for the current shell, TTY, working directory, and Claude session. It does not edit `~/.claude/settings.json`, replace the Claude binary, or affect another terminal.

Writable files live under `${CLAUDE_PLUGIN_DATA}`. The plugin reads the local Codex credential and writes a proxy-compatible copy into its private data directory; it never edits the original Codex auth file.

CLIProxyAPI is an internal protocol adapter, not an authentication command. It is downloaded on demand, pinned to `v7.2.71`, and verified by SHA-256 before use.

See [plugins/cc-codex/docs/ARCHITECTURE.md](plugins/cc-codex/docs/ARCHITECTURE.md) for the routing design.

## Remove

Disable routed conversations first, then run:

```text
/plugin uninstall codex@cc-codex
```

Remove the marked `cc-codex` block from `~/.zshrc` if you no longer want the pass-through integration.

## Develop

```bash
npm run check
npm test
claude plugin validate --strict ./plugins/cc-codex
claude plugin validate --strict .
```
