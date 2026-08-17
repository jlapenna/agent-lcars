# Agent LCARS fleet membership

**Canonical text.** This file is owned by
[jlapenna/agent-lcars](https://github.com/jlapenna/agent-lcars) at
`.agents/fleet-membership.md` and distributed byte-for-byte to every member
repository through that repo's `check-canonical-sync` action and each
member's `.github/canonical-sync.conf` (agent-lcars#1340 B9). Edit it in
agent-lcars; a member repo that edits its own copy fails CI.

It carries only what is true of _every_ member. Repo-local facts — the
worktree mandate (or its absence), required check names, runner labels,
which skills the repo ships, deploy prohibitions — stay in that repo's own
`AGENTS.md`, which links here.

## Dispatch

The hosted control plane at <https://lcars.jlapenna.net> authorizes and
dispatches every headless agent run. `.github/workflows/claude.yml`,
`codex.yml`, and `opencode.yml` are thin callers of the reusable lane
workflows agent-lcars publishes (see its `docs/published-actions.md`), and
`agent-automerge.yml` auto-merges agent-authored pull requests the same way.

Every cross-repo reference to agent-lcars tracks `@main` — never a pinned
tag or SHA. Publishing is deploying: a pinned reference would validate
against a contract that no longer exists.

Consumers depend on agent-lcars, never the reverse, and never through source
imports or shared build contexts — only through published workflows and
actions, the `fleet-tools` PATH package, and byte-pinned canonical-sync
copies.

## Conventions

Dispatched agents follow agent-lcars's **agent-protocol** skill (takeover
comment, eyes reaction, one edited progress comment, parking, the
deliverable-evidence rule, push-early discipline) and its **lcars** delta.
Read them from agent-lcars's `.agents/skills/` when dispatched into a repo
that does not carry its own copy.

## Claim identity

The fleet claims issues as `agent-lcars-bot` — in every repo, including
self-filed issues, the moment work starts:
`gh issue edit <N> --add-assignee agent-lcars-bot`. Never
`--add-assignee @me`: interactively that assigns the maintainer, and in CI
the bot App identity is not assignable, so GitHub silently drops it. Agents
only ever _add_ assignees; removing one is a human act. Blocked on the
maintainer? `--add-label status:needs-human --add-assignee jlapenna`
alongside the claim.

## Fleet tooling

No copies of the fleet's workstation scripts are vendored in member repos
(agent-lcars#1328). The `fleet-*` commands ship as agent-lcars's
`packages/fleet-tools` package and run from PATH, installed per machine with

```bash
pnpm add -g "github:jlapenna/agent-lcars#main&path:packages/fleet-tools"
```

(always `#main`). Sessions watch pull requests with `fleet-watch-prs` and a
single CI run with `fleet-watch-run`; hooks guard every invocation with
`command -v`, so a machine without the package degrades quietly instead of
failing. Repo-specific behavior enters only through each tool's documented
config hook, never by vendoring a copy back into a member repo.

## Credentials

No member repo mints or stores a fleet credential of its own. Every token
the lanes consume has exactly one canonical home, recorded with its mint
procedure in agent-lcars's `docs/fleet-credentials.md`; a repo Actions
secret holding one is a fan-out copy of that canonical value, not a lineage
of its own. The single deliberate exception is the Codex `auth.json`
lineage, which is genuinely per-repo because Codex rotates the credential on
every run and two repos sharing one lineage invalidate each other. Never
commit a credential.
