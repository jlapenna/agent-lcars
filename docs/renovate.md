# Renovate coverage across the fleet

Every fleet repository's dependency updates come from `renovate.json`
extending `github>jlapenna/agent-lcars//renovate-preset` (this repo's
[`renovate-preset.json`](../renovate-preset.json)). What differs per repo is
which **runner** actually executes Renovate against it: the hosted
Mend/Renovate GitHub App, or this repo's self-hosted
[`renovate-self-hosted.yml`](../.github/workflows/renovate-self-hosted.yml)
workflow (agent-lcars#2018).

## Exactly one runner per repo

A repo must be covered by exactly one of the two, never both (a repo Renovate
ran twice a week would double its update PRs and its label/Dashboard-issue
churn) and never neither (a merged `renovate.json` that nothing ever executes
is silent, not safe — that was the actual state of the four self-hosted repos
before agent-lcars#2018).

To tell which runner covers a given repo:

- **Hosted app**: check the repo's installed GitHub Apps
  (`https://github.com/<owner>/<repo>/settings/installations`) for the
  Mend/Renovate app, or look for `renovate[bot]`-authored PRs in its history.
  Extending the hosted app to a new repo needs an `admin:org` credential
  nobody on this machine holds, so this path is not available for repos
  outside whatever the hosted app is already installed on.
- **Self-hosted**: check whether the repo's full name
  (`owner/repo`) appears in this repo's
  [`.github/renovate-self-hosted.json`](../.github/renovate-self-hosted.json)
  `repositories` array — the single source of truth
  `renovate-self-hosted.yml`'s job matrix is computed from. Self-hosted runs
  authenticate as the `agent-lcars` GitHub App and author their PRs as
  `agent-lcars[bot]`, not `renovate[bot]`.

As of agent-lcars#2018:

| Runner      | Repos                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| Hosted app  | `jlapenna/agent-lcars`, `jlapenna/homelab`, `supersprinklesracing/sprinkles`, `jlapenna/sync-padd`           |
| Self-hosted | `supersprinklesracing/www`, `supersprinklesracing/girosf`, `jlapenna/nx-cache-server`, `jlapenna/repo-tools` |

Treat this table as a snapshot, not the contract — `.github/renovate-self-hosted.json`'s `repositories` array is authoritative for the self-hosted
side; there is no equivalent machine-readable list for hosted-app coverage
short of checking each repo's installed Apps.

## Adding or removing a self-hosted repo

1. Merge a `renovate.json` in the target repo that extends
   `github>jlapenna/agent-lcars//renovate-preset` (`requireConfig: "required"`
   in the global config means a repo with no config fails loudly instead of
   silently onboarding).
2. Confirm the `agent-lcars` GitHub App is installed on that repo, with at
   least `contents:write`, `issues:write`, `pull_requests:write`, and
   `workflows:write` (needed the moment the repo has any
   `.github/workflows/*.yml` for Renovate's github-actions manager to touch).
3. Add (or remove) the repo's full name in
   [`.github/renovate-self-hosted.json`](../.github/renovate-self-hosted.json)'s
   `repositories` array. The workflow's job matrix, and the per-owner App
   token scope it mints, are both computed from that array — nothing else
   needs to change.
4. Validate the edited config before pushing:
   ```bash
   timeout 300 npx --yes --package renovate@latest -- \
     renovate-config-validator --strict .github/renovate-self-hosted.json
   ```
5. Removing a repo from self-hosted coverage does not touch that repo's own
   `renovate.json` — it just stops this workflow from ever running against
   it. Deleting or disabling its `renovate.json` there, if desired, is a
   separate, repo-local edit.

Do not add a repo here that the hosted app already covers, or vice versa —
see "Exactly one runner per repo" above.

## Dispatching a dry run

`renovate-self-hosted.yml`'s `workflow_dispatch` trigger takes two optional
inputs:

- `dry_run` (default `full`): Renovate's dry-run mode. `full` extracts,
  looks up updates, and logs what it would branch/PR without pushing a
  commit or opening anything. Leave it at the default for a safe manual
  check; set it to an empty string to force a real run from a manual
  dispatch (the weekly schedule trigger always runs for real regardless of
  this input).
- `repositories`: an optional comma-separated subset of the four self-hosted
  full names (e.g. `jlapenna/repo-tools`) to scope a run to, for testing a
  single repo without touching the others. Leave empty to run the whole
  self-hosted fleet.

```bash
gh workflow run renovate-self-hosted.yml
# or, scoped to one repo, for real:
gh workflow run renovate-self-hosted.yml -f dry_run= -f repositories=jlapenna/repo-tools
```

## The draft-majors rule

A self-hosted run authenticates as the `agent-lcars` App, so every PR it
opens in the four member repos is authored by `agent-lcars[bot]`. Each of
those repos' own `agent-automerge-reusable.yml` treats any bot login in its
`AGENT_BOT_LOGINS` repository variable — which includes `agent-lcars[bot]` —
as auto-mergeable the instant a **non-draft** PR is opened or turns ready.
A major version bump landing on green CI with no human review is not
acceptable.

`renovate-preset.json` carries a `packageRules` entry matching
`matchUpdateTypes: ["major"]` that sets `draftPR: true`, `automerge: false`,
and `addLabels: ["status:needs-human"]`. Draft status is set atomically at
PR creation, so a major update is never briefly visible as an armable
non-draft PR; `status:needs-human` is added after creation (racy against the
auto-merge listener) and exists for human triage, not as the actual guard.

This rule lives in the **shared preset**, not in
`.github/renovate-self-hosted.json`'s global config, on purpose: Renovate
resolves a repository's own config — including everything it pulls in via
`extends`, i.e. this preset — after the self-hosted global config, and lets
whichever match comes later win field-by-field. A rule placed only in the
global config could therefore be silently overridden by some future
repo-level `packageRule` in one of the four repos. A rule in the preset
itself is resolved as part of each repo's own config and applies to every
consumer, hosted or self-hosted, uniformly. See `renovate-preset.json`'s
inline comment on that rule for the full reasoning.

Non-major updates keep the preset's existing behavior unchanged: grouped and
auto-merged via `platformAutomerge: true` once CI is green, the same as the
hosted-app repos.

## Rollback

Disable `.github/workflows/renovate-self-hosted.yml` (`gh workflow disable
renovate-self-hosted.yml` from this repo, or delete the schedule trigger)
to stop all self-hosted runs. This does not touch the four member repos —
their merged `renovate.json` stays in place, simply unexecuted, exactly as
it was before agent-lcars#2018 — and does not affect the hosted app's
coverage of the other four repos at all.

## Known gap: vulnerability alerts

Each self-hosted repo's `renovate.json` sets `vulnerabilityAlerts.enabled:
true` (inherited fleet-wide), but that feature reads GitHub's Dependabot
alerts API, which needs a `vulnerability-alerts: read` App permission the
`agent-lcars` App does not currently hold. Self-hosted runs are expected to
skip or warn on vulnerability-alert lookups rather than fail outright; this
is a known limitation, not something `renovate-self-hosted.yml` works around.
