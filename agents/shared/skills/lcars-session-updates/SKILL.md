---
name: lcars-session-updates
description: Use when working a long or multi-phase task while the person who asked is away, when several agents run at once and someone needs to tell them apart at a glance, when a session's focus drifts from the prompt that opened it, or when about to report progress only into chat that nobody is reading.
---

# LCARS Session Updates

The `lcars session title`/`lcars session status` commands and the guidance
on when to use them now live in
[agent-protocol.md §12](../agent-protocol/reference/agent-protocol.md#12-session-status-channel)
— read that section directly; this file exists only so Claude Code can
auto-discover and surface the guidance under this skill's own trigger
phrases (a long task while someone is away, telling concurrent sessions
apart, a session whose focus drifted), which are broader than "dispatched
as a headless agent."

Chat output, a tmux window title, and an interrupting channel (Telegram,
SMS, Slack) each reach a different audience than the console does — a tmux
title is invisible to anyone not at that terminal, and invisible entirely
for a headless run with no pane. If the person you're updating is away and
not reading the transcript, the console is the only one of these that
reaches them; see §12 for the actual commands and cadence.
