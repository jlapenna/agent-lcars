# Agent LCARS contributor notes

## CRITICAL: Initialization

Project-specific workflows and guardrails (worktree/git safety, PRs,
verification) are defined by the **agent-lcars-dev** skill — it is the
single source of truth; do not duplicate its guardrail text elsewhere in
this file. Headless-CI-dispatch conventions (takeover comment, parking,
identity, dispatch/reconciliation) are defined by the **agent-protocol** and
**lcars** skills instead — read those when dispatched as a headless agent.

The project skills live in `.agents/skills/`. Depending on your agent
runtime:

- **Claude Code**: these skills are exposed via symlinks under
  `.claude/skills/`. Invoke them with the `Skill` tool (e.g.
  `agent-lcars-dev`) — they are auto-discovered from their `description:`
  frontmatter, which is written to match broadly for this repo (including
  generic-seeming tasks), so no explicit forced load is needed here. There
  is no `activate_skill` tool.
- **Codex**: repository skills are catalogued by the local plugin
  marketplace manifest in `.agents/skills/.claude-plugin/marketplace.json`.
  Trusted Codex sessions load `.codex/hooks.json`, and Claude sessions load
  `.claude/settings.json`; both run the shared issue-workflow hook after Bash
  commands. When a command uses `gh issue view` or `gh issue edit`, the hook
  verifies `agent-lcars-bot` ownership and the issue-specific tmux title.

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
its spec) are correctness-critical twins instead: behavioral changes must
land in both repos, and sprinkles CI keeps them honest with its drift
detector (`tools/check-lint-rule-drift.cjs` in supersprinklesracing/
sprinkles), which pins the last-reconciled content of each pair and fails
when either side moves past the pin. Cross-repo source imports remain
forbidden either way.

Never commit credentials. Runtime secrets belong in GCP Secret Manager and the
host writer credential belongs in the encrypted homelab secret store. Terraform
owns secret containers but not secret values.

Checkout safety, worktree mandate, and the full hard-limits list live in
[agent-lcars-dev's SKILL.md](.agents/skills/agent-lcars-dev/SKILL.md#hard-guardrails)
— read it before editing files or running any git-mutating command.
