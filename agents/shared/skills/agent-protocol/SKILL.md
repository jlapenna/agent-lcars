---
name: agent-protocol
description: The complete cross-repo behavioral contract for any headless coding agent dispatched against a GitHub issue or pull request in the Agent LCARS fleet — identity, provider-honest takeover, dispatch modes, reactions, progress, parking, deliverable evidence, budget discipline, CI reruns, session status, and hard limits. Use when dispatched as a headless CI agent, when changing dispatch prompts in this or a consuming repo, or when asked how fleet agent behavior works.
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

This directory is this repo's canonical, single source of the protocol.
QueueExecutor's baked native runtime resolves
`reference/agent-protocol.md` from its adjacent trusted skill tree; consumer
repositories do not download or hardcode that path. Keep that resolution in
lockstep with the runner image and its direct-runner contract test.
`.agents/skills/agent-protocol` is a symlink to this directory, kept so
interactive Claude Code and Codex dev sessions in this repo still
auto-discover it.
