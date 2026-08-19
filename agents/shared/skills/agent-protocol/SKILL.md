---
name: agent-protocol
description: The generic, cross-repo conventions any headless coding agent follows when dispatched against a GitHub issue or pull request in this fleet (agent-lcars, sprinkles/members) — takeover comment, eyes reactions, one edited progress comment, the console session-title/status channel, parking, the deliverable-evidence rule, push-early discipline, budget discipline, CI reruns, the headless-synchronous rule, hard limits. Use when dispatched as a headless CI agent, when changing dispatch workflow prompts in this or a consuming repo, or when asked how takeover/parking/deliverable/session-status conventions work across the fleet.
---

# Agent Protocol

The protocol every dispatch must read lives in
[reference/agent-protocol.md](reference/agent-protocol.md) — read it
directly; this file exists only so Claude Code can auto-discover and
surface it by description.

The situational sections — §8 (CI reruns and the `action_required` platform
fact) and §10 (the bot-identity assignment gotcha) — live in
[reference/index.md](reference/index.md). Read that file
**only once you have hit the situation it describes**: the main file is a
fixed cost on every dispatch on every provider, and #1210 split these out so
that cost stops including sections most runs never need. Section numbers are
unchanged, so `§8`/`§10` cross-references from any repo still resolve.

This directory is this repo's canonical, single source of every consuming
repo's copy of the protocol: a cross-repo `uses:` on `prepare-agent-dispatch`
downloads this whole repository, and the action resolves
`reference/agent-protocol.md` relative to its own `GITHUB_ACTION_PATH`
(`.github/actions/prepare-agent-dispatch/prepare.sh`). No consuming repo
hardcodes this path itself — it only invokes the composite action — so this
directory can be relocated, but only in the same change that updates
`prepare.sh` (and its test) to match. `.agents/skills/agent-protocol` is a
symlink to this directory, kept so interactive Claude Code and Codex dev
sessions in this repo still auto-discover it.
