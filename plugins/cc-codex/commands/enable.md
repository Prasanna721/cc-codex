---
description: Route this Claude conversation through Codex in this terminal on its next launch
argument-hint: '[MODEL]'
allowed-tools: []
---

The plugin hook has already handled this command and supplied the complete result as additional context.

Return that result exactly. Do not invoke tools or add advice.

If no result is present, tell the user to run `/reload-plugins` and invoke `/codex:enable` again.
