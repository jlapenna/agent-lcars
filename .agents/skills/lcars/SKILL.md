---
name: lcars
description: agent-lcars repo-specific delta on top of agent-protocol — fleet-claim identity (jclaw-bot), maintainer/reviewer login, how dispatch and reconciliation actually work today (libs/orchestrator's per-task mutex, lease-based loss recovery, bounded auto-retry — there is no ledger), auto-merge, session-resume script, and hard limits unique to this repo. Use when dispatched as a headless CI agent in agent-lcars, when changing orchestrator/reconcile/auto-merge workflows, or when asked how this repo's own agent identity or dispatch/reconciliation works.
---

# LCARS Protocol

The full repo-specific delta lives in
[lcars-protocol.md](lcars-protocol.md) in this same directory — read it
directly; this file exists only so Claude Code can auto-discover and
surface it by description.

Read [agent-protocol](../agent-protocol/SKILL.md) first — this is a delta
on top of it, not a replacement. General dev guardrails (worktrees, verify
commands, hard limits for interactive sessions) live in the
[agent-lcars-dev](../agent-lcars-dev/SKILL.md) skill; this skill covers
only the headless-dispatch delta.
