# Onboarding a repository to the agent fleet

The end-to-end runbook for admitting a new repo, in the order the pieces
depend on each other. It sequences the aspect docs rather than repeating
them; the 2026-08 onboarding of `supersprinklesracing/{www,girosf}` and
`jlapenna/{nx-cache-server,sync-padd}` (#1325) executed exactly this path
and is the reference example — PRs #1326 (center), homelab#734 (capacity),
and www#2 / girosf#14 / nx-cache-server#18 / sync-padd#53 (per-repo
bootstrap).

Two principles shape every step:

- **Nothing is copied.** Lanes and automerge are `workflow_call` references
  to this repo's published reusables `@main`; workstation/session tooling
  comes from the `fleet-tools` package on PATH (#1328) — a bootstrap PR
  that vendors a script body is wrong.
- **Nothing first-party is pinned.** Every cross-repo reference is `@main`;
  the runner image builds from fresh `main`.

## 0. Decide the shape

A starter repo gets ONE general-purpose runner pool
(`homelab-autoscale-<repo>-default`, min 0 / max 2) and empty
required-checks governance if its CI is nascent. Split ci/agent/e2e pools
and real required checks arrive later, driven by measured demand — never
copied ahead of it.

## 1. Center: make the console watch the repo (this repo)

One PR here (#1326's shape):

- `config/github-labels.json`: a repo entry mirroring homelab's
  declaration (the `type:*`/`status:*`/`agent:*`/`review:*` core plus
  `migrations`/`remove` cleanup lists).
- `apps/console/apphosting.yaml`: add the repo to both
  `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES` (comma list) and
  `AGENT_LCARS_WATCHED_REPOS` (JSON array; alias = repo name).
- `.github/workflows/label-contract-audit.yml`: add the repo to the fleet
  matrix (without this the manifest entry never syncs).
- `docs/published-actions.md`: extend the consumer enumeration.

Merging deploys the console automatically (`deploy-console.yml` off green
main CI).

## 2. Capacity: runner registration (jlapenna/homelab)

One PR there (homelab#734's shape) — see
[onboarding-autoscaler.md](onboarding-autoscaler.md) for the full model:

- `github-runner-autoscaler/orchestrator.yml`: a `registrations:` entry on
  the **autoscaler App** (client `Iv23lir3t9e2k4RAkWxw`, key already on
  the controller) with one starter scale set per §0. Installation IDs:
  `154210710` (jlapenna account), `154210731` (supersprinklesracing).
- `terraform/github_rulesets.tf`: a `protect-main` module for the repo.
  With `required_checks = []` the module emits no required-status-checks
  rule at all (a check no workflow reports would brick every PR) while
  keeping linear history, no force-push/deletion, and thread resolution.
  `terraform apply` is a separate maintainer act.

Deployment is automatic: `merge-to-live` on the canonical controller
redeploys the autoscaler within minutes of the merge. Verify the listener:

```bash
ssh homelab@homelab 'docker logs runner-autoscaler --since 5m 2>&1 |
  grep "scale_set=homelab-autoscale-<repo>-default"'
```

A polling `Getting next message` line means registration worked. If it
errors instead, the autoscaler App installation doesn't cover the repo yet
(§3).

## 3. App installations (GitHub UI, maintainer)

Both Apps use "Only select repositories", and GitHub's API for membership
only accepts App _user_ tokens — so this is UI work:

- **Fleet App** (`Iv23liO6X8pLJLcTFzyv` — lanes, claims, console):
  [jlapenna installation](https://github.com/settings/installations/150568943) ·
  [supersprinklesracing installation](https://github.com/organizations/supersprinklesracing/settings/installations/150568991)
- **Autoscaler App** (`Iv23lir3t9e2k4RAkWxw` — runner registration):
  installations `154210710` / `154210731` under the same two accounts.

Verify coverage without guessing (the fleet App's key is in Secret
Manager): mint an installation token and list
`/installation/repositories` — the 2026-08 onboarding found three of four
repos already covered and only `www` missing, so check before clicking.

## 4. Repo bootstrap: thin callers + hooks (the new repo)

One PR in the target repo (the post-de-vendoring shape of www#2 /
girosf#14 / nx-cache-server#18 / sync-padd#53):

- `.github/workflows/{claude,codex,opencode}.yml`: thin callers of
  `jlapenna/agent-lcars/.github/workflows/agent-lane-<lane>.yml@main`.
  The caller owns only what `workflow_call` cannot carry: the
  `workflow_dispatch` input contract, run-name, permissions, per-issue
  concurrency, this repo's variable/secret spellings, and the
  `agent-fallback-finalize.yml@main` callback. Copy an existing caller
  (homelab's are the cleanest) and change only repo-specific values.
- `.github/workflows/agent-automerge.yml`: thin caller of
  `agent-automerge-reusable.yml@main`. Inert until `AGENT_BOT_LOGINS`
  exists — it skips cleanly, not red.
- `.github/workflows/repo-validation.yml`: a thin caller of
  `repo-validation.yml@main` with `canonical-sync: true` (#1340 A-R5/B8) —
  it owns only triggers, permissions, and concurrency. Keep it on
  GitHub-hosted runners (the reusable's default): it must stay
  green-capable before self-hosted capacity exists. Its composed check
  name is `validate / repository validation`.
- `.claude/settings.json` + `.codex/hooks.json`: the issue-workflow
  guardrail hook invoking the PATH command, guarded so uninstalled
  machines degrade quietly:

  ```
  guard=$(command -v fleet-codex-issue-guardrail || true); if [ -n "$guard" ]; then fleet-codex-issue-guardrail; fi; exit 0
  ```

- Git hooks (husky/pre-commit, whatever the repo uses):
  `if command -v fleet-require-worktree >/dev/null 2>&1; then fleet-require-worktree; fi`
- `agents/opencode/opencode.json`: the homelab LiteLLM provider block (the
  lane sets `OPENCODE_CONFIG` to this path since opencode's own
  auto-discovery only looks at the repo root).
- `AGENTS.md`: a fleet section naming the install
  (`pnpm add -g "github:jlapenna/agent-lcars#main&path:packages/fleet-tools"`),
  the `fleet-*` commands, and the worktree mandate.

**No vendored scripts, and no `canonical-sync.conf` by default.** A new
repo copies nothing from this one — it reads the fleet's conventions here.
A manifest (and `repo-validation.yml`'s `canonical-sync: true`) is warranted only
once the repo genuinely acquires a file that must be byte-identical to one
of ours, such as the `worktree-hygiene` skill doc. If a repo has stale
pre-#1328 script copies on its main, delete them in this PR.

## 5. Provision vars and secrets

Automatable from any session (values never echoed):

```bash
r=<owner>/<repo>; short=${r#*/}
gh variable set AGENT_LCARS_CLIENT_ID -R "$r" --body 'Iv23liO6X8pLJLcTFzyv'
gh variable set AGENT_FLEET_LOGIN     -R "$r" --body 'agent-lcars-bot'
gh variable set MAINTAINER_LOGIN      -R "$r" --body 'jlapenna'
gh variable set AGENT_BOT_LOGINS      -R "$r" --body '["claude[bot]","agent-lcars[bot]"]'
gh variable set AGENT_RUNNER_LABEL    -R "$r" --body "${short}-default"
gcloud secrets versions access latest --secret=AGENT_LCARS_APP_PRIVATE_KEY \
  --project=agent-lcars | gh secret set AGENT_LCARS_PRIVATE_KEY -R "$r"
secrets-cat | grep '^OPENCODE_LLM_API_KEY=' | cut -d= -f2- |
  gh secret set OPENCODE_LLM_API_KEY -R "$r"
```

Then verify by listing, not by trusting the loop (GitHub 503s drop
writes silently): `gh variable list -R "$r"` should show 5,
`gh secret list -R "$r"` should show 2.

The claude lane needs nothing further: its subscription token is read
from Secret Manager at run time and no repo carries a copy (#1350). The
repo does need `permissions: id-token: write` on the calling job, and to
appear in `local.github_repositories` (`infra/terraform/main.tf`) so the
shared `github` pool admits its OIDC token.

The maintainer-mintable remainder — the per-repo Codex `auth.json`
lineage (+ its WIF plumbing) and any new LiteLLM key — is
[fleet-credentials.md](fleet-credentials.md). Until those exist the
corresponding lanes fail at a specific, named step (Codex: "Restore
subscription authentication") — that exact failure is the expected dark
state, not a bug.

## 6. Console + telemetry integration detail

[onboarding-console-and-telemetry.md](onboarding-console-and-telemetry.md)
covers the agent-protocol expectations (takeover comments name
`fleet-claude-agent-session`), telemetry sidecar wiring, and the IAM
grant that needs explicit maintainer approval.

## 7. Prove it end to end

Don't declare the repo onboarded on green config — run one real dispatch:

1. Label a real issue `agent:opencode` (its LiteLLM key is automatable
   from the age store, so it works without a maintainer mint).
2. Watch the run: the run-name must carry the orchestrator's
   `[dispatch:g<gen>:<intent>]` marker (a bare run-name means the
   dispatch bypassed the control plane), and the job must land on
   `<repo>-default`.
3. Repeat with `agent:claude`. Since #1350 that needs no per-repo
   credential work — the lane reads the fleet's one canonical
   subscription token at run time — so it only needs the repo admitted by
   the shared `github` WIF pool (§5).

The 2026-08 onboarding's first real dispatch (girosf#15) validated
admission, listener, token mint, and failure reporting in one run —
before any lane credential existed. That's the bar: the machinery proves
itself even while lanes are dark.
