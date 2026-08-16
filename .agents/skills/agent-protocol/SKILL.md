---
name: agent-protocol
description: The generic, cross-repo conventions any headless coding agent follows when dispatched against a GitHub issue or pull request in this fleet (agent-lcars, sprinkles/members) — takeover comment, eyes reactions, one edited progress comment, parking, the deliverable-evidence rule, push-early discipline, budget discipline, CI reruns, the headless-synchronous rule, hard limits. Use when dispatched as a headless CI agent, when changing dispatch workflow prompts in this or a consuming repo, or when asked how takeover/parking/deliverable conventions work across the fleet.
---

# Agent Protocol

The protocol every dispatch must read lives in
[agent-protocol.md](agent-protocol.md) in this same directory — read it
directly; this file exists only so Claude Code can auto-discover and
surface it by description.

The situational sections — §8 (CI reruns and the `action_required` platform
fact) and §10 (the bot-identity assignment gotcha) — live in
[agent-protocol-reference.md](agent-protocol-reference.md). Read that file
**only once you have hit the situation it describes**: the main file is a
fixed cost on every dispatch on every provider, and #1210 split these out so
that cost stops including sections most runs never need. Section numbers are
unchanged, so `§8`/`§10` cross-references from any repo still resolve.

This file's path is a **fixed cross-repo contract, not just a convention**:
consuming repos' CI (e.g. sprinkles' `claude.yml`/`opencode.yml`/`codex.yml`
via the `prepare-agent-dispatch` action) fetch
`.agents/skills/agent-protocol/agent-protocol.md` by this exact path. Never
move or rename `agent-protocol.md` itself — this `SKILL.md` is additive,
not a replacement.

This repo also maintains its own delta on top — see the
[lcars](../lcars/SKILL.md) skill — which takes precedence wherever the two
disagree.
