---
name: lcars
description: Situational Agent LCARS control-plane reference for how dispatch, reconciliation, telemetry, and auto-merge work today. Use when changing orchestrator, reconciliation, provider telemetry, or auto-merge machinery, or when asked how the fleet control plane works. Do not load it for ordinary dispatched work; the shared agent-protocol is complete.
---

# LCARS Control Plane

The control-plane summary lives in [lcars-protocol.md](lcars-protocol.md).
Read it when this task enters that domain; it is not a mandatory dispatch
document or a `protocol-note`.

How dispatch, reconciliation, and the session-resume story actually work
underneath — none of which a dispatched agent acts on — lives in
[lcars-protocol-reference.md](lcars-protocol-reference.md). Read it when you
are changing that machinery, not before starting a task (#1210).

Fleet worker behavior lives completely in
[agent-protocol](../agent-protocol/SKILL.md). General dev guardrails
(worktrees, verify commands, hard limits for interactive sessions) live in the
[agent-lcars-dev](../agent-lcars-dev/SKILL.md) skill; this skill covers
only the control-plane implementation.
