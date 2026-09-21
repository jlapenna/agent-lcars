---
name: lcars-session-updates
description: Update LCARS console session titles or status when the user asks for console visibility; route autonomous LCARS workers to their dispatch protocol. Interactive progress belongs in the conversation by default.
---

# LCARS Session Updates

## Interactive sessions

Report progress, questions, and results in the conversation. Being long-running,
working in a fleet repository, or having a user temporarily away does not turn
an interactive session into an autonomous worker. Do not load the headless
protocol or impose its status cadence, PARK outcomes, or deliverable markers.

When the user asks for console visibility, these optional commands update local
session state without requiring a dispatch identity:

```bash
lcars session title "<current task>"
lcars session status "<current state>"
```

Use `tmux-window-title` for terminal visibility. Console updates do not replace
conversation updates or authorize sending messages through other channels.

## Autonomous LCARS workers

Follow [agent-protocol.md §12](../agent-protocol/reference/agent-protocol.md#12-session-status-channel)
for the dispatch status channel and cadence. Those obligations apply only to
explicit LCARS dispatches.
