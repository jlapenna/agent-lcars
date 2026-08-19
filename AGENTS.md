# Agent LCARS contributor notes

## CRITICAL: Initialization

Project-specific workflows and guardrails (worktree/git safety, PRs,
verification) are defined by the **agent-lcars-dev** skill — it is the
single source of truth; do not duplicate its guardrail text elsewhere in
this file. Headless-CI-dispatch conventions (takeover comment, parking,
identity, dispatch/reconciliation) are defined by the **agent-protocol** and
**lcars** skills instead — read those when dispatched as a headless agent.

Skills are auto-discovered per-runtime from `.agents/skills/` — don't skip
checking for one just because a task looks generic. A `PostToolUse` hook
runs after Bash commands and blocks premature `gh issue view`/`gh issue
edit` calls; see the github-issue-workflow skill for the claim/ownership
flow it enforces.

Local initialization uses `pnpm install`, whose `prepare` lifecycle installs
and verifies Husky through `tools/setup-git-hooks.sh`. Linked worktrees use
`tools/setup-worktree.sh`; the primary checkout remains a clean `main`.
GitHub's active `Protect main` ruleset additionally requires the `Verify`
check and resolved review threads before merge.

If a skill is not discoverable, read its `SKILL.md` and `references/`
files directly from `.agents/skills/<name>/`.

> [!IMPORTANT]
> Git and deployment guardrails (worktrees mandatory, no `--no-verify`, and
> explicit maintainer approval required for direct deployment or
> Terraform/Firestore access) live in
> [`.agents/skills/agent-lcars-dev/SKILL.md`](.agents/skills/agent-lcars-dev/SKILL.md#hard-guardrails).
> Read them there — this section intentionally does not restate them.

Member repositories read this repo's fleet conventions directly — the
**agent-protocol** skill for dispatched-agent behavior, `docs/` for the
dispatch, credential, and published-workflow contracts. Nothing is copied
into them: a doctrine document byte-synced across seven repos was
duplication plus machinery to police the duplication, and it was removed.
Repo-local facts stay in each member's own `AGENTS.md`.

Keep this repository independent from the supersprinklesracing source tree.
Shared telemetry integration is delivered by baking
`apps/telemetry-watcher`'s bundle into the shared runner image at
image-build time, built fresh from this repo's own `main`
(`apps/runner-autoscaler/runner-image/Dockerfile` — see issue #30); this
replaced an earlier versioned-standalone-bundle-on-GCS scheme (issue #29,
retired for good in #66) whose published pin went stale for months. Do
not add cross-repository _source_ imports or build contexts elsewhere —
this one image-build integration point is the sanctioned exception, not a
precedent for others. Publishing this repo's composite actions for fleet
consumption (consumers reference `jlapenna/agent-lcars/.github/actions/*`)
is the sanctioned direction of dependency — consumers depend on this repo,
never the reverse — see [docs/published-actions.md](docs/published-actions.md).

That independence has a deliberate price (#1311): a tail of small foundation
files is duplicated in both repos on purpose — per-lib `.swcrc`,
`.prettierrc`, `tools/eslint-rules/tsconfig.lint.json`,
`libs/test-utils/src/server-only-mock.js`, ambient `*.d.ts` declarations,
`CODEOWNERS`, `LICENSE`, `tools/nx-remote-cache-read-failure.test.sh` — and
that tail may drift freely; do not "fix" it by sharing files. The two
ESLint-rule pairs under `tools/eslint-rules/rules/`
(`no-server-only-imports-in-client` and `use-server-actions-only`, each with
its spec) are correctness-critical twins instead: they are kept
byte-identical and repo-neutral, this repo holds the canonical copy, and
sprinkles CI keeps them honest through its `.github/canonical-sync.conf`
with this repo's check-canonical-sync published action (the mechanism that
replaced the short-lived drift detector, sprinkles#4496). Behavioral
changes land here first and are re-copied verbatim. Cross-repo source imports remain
forbidden either way.

Never commit credentials. Runtime secrets belong in GCP Secret Manager and the
host writer credential belongs in the encrypted homelab secret store. Terraform
owns secret containers but not secret values.
