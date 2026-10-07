# Fleet-consumable GitHub Actions

Agent LCARS publishes selected composite actions and reusable workflows for
fleet repositories. The action or workflow manifest is the executable input,
output, and permission contract; this page identifies supported surfaces and
their operating constraints.

## Support tiers

| Tier          | Consumer contract                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Published** | Cross-repository use is supported. Composite-action surfaces are guarded by `published-actions.contract.test.mjs`. |
| **Internal**  | Used only by Agent LCARS workflows. No compatibility promise.                                                      |
| **Coupled**   | Bound to the Agent LCARS dispatch or runner trust boundary. Do not consume.                                        |

## Published composite actions

| Action                  | Purpose                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `mint-agent-token`      | Mint a scoped Agent LCARS App installation token.                       |
| `assert-repo-vars`      | Report all missing required repository variables.                       |
| `merge-live-base`       | Merge the live base into a PR head before validation.                   |
| `setup-nx-remote-cache` | Configure trusted Nx jobs for the shared L2 cache.                      |
| `deploy-verify`         | Poll a deployed URL and optionally annotate deployment status.          |
| `oidc-post`             | Send an OIDC-authenticated request and expose its single response.      |
| `control-flag`          | Make an engaged fleet control flag visible in logs and the job summary. |

## Published reusable workflows

| Workflow                       | Purpose                                        |
| ------------------------------ | ---------------------------------------------- |
| `renovate-auto-approve.yml`    | Approve a Renovate PR with a minted App token. |
| `agent-automerge-reusable.yml` | Arm and reconcile agent PR auto-merge.         |
| `repo-validation.yml`          | Run actionlint, runner-label, schedule checks. |
| `codeql-reusable.yml`          | Run the caller-configured CodeQL analysis job. |

Hosted provider workflows are retired; providers execute through the Console
QueueExecutor instead.

`agent-automerge-reusable.yml`'s `reconcile-automerge` job also updates a
BEHIND branch on any open, non-draft, non-parked PR that already has
auto-merge armed (arming auto-merge is the opt-in, except for dependency
bots such as Renovate and Dependabot, which retain branch ownership):
GitHub's own auto-merge arms a PR but never updates its branch, so under a strict "up to date" ruleset a PR whose head falls behind
`main` after another merge stalls indefinitely until a human rebases it
(#1748; jlapenna/homelab#1121 sat 16 hours this way with green checks and
auto-merge armed). The sweep only acts once a PR's checks are all green with
none still running and it has no unresolved review thread, re-checks a
stale `UNKNOWN` mergeability up to three times, prefers `gh pr update-branch --rebase`
and falls back to the default merge-commit update if the rebase form is
refused, and is capped at 5 updates per run.

The sweep never updates Renovate or Dependabot PRs (#2049). Updating a
Renovate branch with `GITHUB_TOKEN` can suppress follow-up CI and cause
Renovate to treat the branch as externally modified. The shared Renovate
preset sets `rebaseWhen: "auto"` so Renovate handles behind-branch updates
for strict up-to-date rulesets itself. Consumers overriding that setting
with `"conflicted"` must remove the override or use `"behind-base-branch"`.
This leaves branch updates and the resulting CI events under Renovate's
own identity.

The workflow's required `runs-on` input selects the short-lived glue-job
pool. Consumers whose required-check aggregators use that same constrained
pool should also set `restore-runs-on` to a different pool. The persistent
`restore-main-checks` job can wait for the required checks for
`check-wait-minutes`; separating it prevents the waiter from occupying the
only runner needed by the checks it is waiting for. Existing consumers that
omit `restore-runs-on` retain the `runs-on` value.

### Auto-merge identity

Set `app-token-enabled: true`, pass `vars.AGENT_LCARS_CLIENT_ID` as
`app-client-id`, and map `secrets.AGENT_LCARS_PRIVATE_KEY` to
`APP_PRIVATE_KEY` for the preferred fleet path. The reusable workflow mints a
short-lived token limited to the current repository and only the permissions
used by its arm or reconcile job. GitHub then performs the merge as the Agent
LCARS App, preserving the normal `push` and `workflow_run` event chain, native
`Closes` handling, and repository branch deletion.

An App-enabled caller must use `pull_request_target`, not `pull_request` or
`pull_request_review`, and must never check out or execute PR-head content in
that workflow. This keeps the private key in workflow code loaded from the
trusted default branch. The reusable arm job rejects App mode on any other PR
event as defense in depth. Legacy callers do not receive the App secret and
retain their existing `pull_request`/`pull_request_review` triggers.

The caller must also grant its `GITHUB_TOKEN` `statuses: read` alongside
`checks: read`; GitHub's `statusCheckRollup` query fails as a whole when a
commit-status context exists and either scope is missing. Read-only rollup
queries use that token because the fleet App intentionally has no commit-status
grant; mutations continue to use the repository-scoped App token. App-enabled
callers add a `push: [main]` trigger. That first trusted-base run migrates any
still-open agent PR armed by the exact legacy `app/github-actions` identity: it
disables the legacy request and re-arms with the App token before the restore
path is considered retired. Human and other App arms are preserved. Every
reconciliation run performs the migration; if the cutover PR's own legacy
merge actor suppresses that first push, run the caller once with a plain
`workflow_dispatch`.

The input defaults to false for compatible per-repository rollout. A caller
that has not supplied the App credential continues to use `GITHUB_TOKEN`; for
that caller only, `restore-main-checks` and `close-orphaned-anchors` remain the
post-merge compatibility path, and its cron schedule remains the trigger for
`reconcile-automerge` and `close-orphaned-anchors`.

An App-enabled caller reconciles on events instead of a short poll: `push` to
main (when an armed PR falls behind) and `workflow_run` `completed` for every
workflow that posts checks on a PR head (when an armed PR turns green; the
reusable admits only successful `pull_request` runs, and its green gate waits
on all checks, not only required ones). App merges and App-pushed PR heads
emit both events. A late thread resolution, a late arm, mergeability still
`UNKNOWN` after the sweep's bounded re-reads, or a transiently failed sweep
emits nothing subscribable, so keep at most a daily `schedule` backstop plus
`workflow_dispatch` for manual repair. Pass no restore-chain inputs.

## Not consumer surfaces

| Tier     | Names                              |
| -------- | ---------------------------------- |
| Internal | `setup-node-pnpm`, `ci-log-stream` |

## Live CI logs

The internal `ci-log-stream` action makes the long `Full verification` job
observable before GitHub publishes its completed log archive. On trusted fleet
runners it tails the runner's already-secret-masked rotating page logs and
pushes them directly to Loki; GitHub-hosted fork jobs cleanly no-op.

The Loki stream uses only low-cardinality labels:

```logql
{job="gha-ci", repo="jlapenna/agent-lcars", workflow="CI", runner_host="laforge"}
```

Run ID, run attempt, job name, step name, commit SHA, and an optional Agent
LCARS attempt ID are structured metadata, not labels. The shipper rescans for
rotated pages and follows the cumulative job record rather than the duplicate
per-step records. It bounds its in-memory queue at 2 MiB, uses no disk spool,
drops new lines under sustained backpressure, and never changes the job result
when Loki or the runner helper is unavailable. The `gha-ci` Loki stream has
48-hour retention; GitHub's completed job archive remains the longer-lived
record.

## Consume a published surface

```yaml
- uses: jlapenna/agent-lcars/.github/actions/<name>@main
```

```yaml
jobs:
  task:
    uses: jlapenna/agent-lcars/.github/workflows/<workflow>.yml@main
```

`@main` intentionally follows current fleet behavior. A deprecated surface
is removed outright once nothing references it, with that verification --
every fleet repository grepped, plus a GitHub-wide code search -- recorded
in the removing pull request.

Reusable-workflow callers retain their triggers, workflow-level permissions,
concurrency, repository-variable spellings, and any required fallback job.
Each workflow's `workflow_call` declaration is authoritative for required
inputs and secrets; add a `with:` block only for inputs that declaration
accepts.

## Security invariants

- Request the narrowest `mint-agent-token` permissions.
- A QueueExecutor run succeeds only when its native verifier finds its exact
  `<!-- attempt-claim:<attempt-id> -->` marker on a deliverable. Progress and
  takeover comments are not deliverables.
- Marker stamping is enabled only for the untrusted agent step. Post-agent
  gates must never enable it, because a gate must not satisfy its own evidence
  check.
- A cross-repository `uses:` download contains the whole referenced repository.
  An action that relies on a sibling path must declare that dependency in its
  manifest.

`oidc-post` exposes the exact response body through its `response`
output for a successful bodyless or `payload` request. Batch `payloads` mode
has no singular response, so its output is empty. The action does not parse or
assign endpoint-specific meaning to either response shape. GitHub-anchor
automation uses that generic transport with the Work API's `/dispatches/github`
endpoint and `agent-lcars-work` audience; the generated Work OpenAPI contract,
not this transport action, defines the dispatch payload and response. A GitHub
dispatch may send GitHub's complete
valid anchor body (including an empty body). The service preserves non-empty
bodies that already fit the Work description limit exactly, and normalizes
empty or oversized bodies with the shared Work byte-budget/truncation rule
before authorization or storage; callers must not pre-truncate it.

## Native repository checks

`setup-repo-checks` is Published. Set `tool: gitleaks` for Gitleaks 8.18.2,
or `tool: actionlint` for actionlint (optional `actionlint-version`, default
1.7.7), ShellCheck 0.10.0 and Pyflakes 3.2.0. It adds the executables to PATH
on Linux x64/arm64 using a temporary directory and verified release archives.
The actionlint toolchain requires xz to unpack ShellCheck, plus Python 3 and
pip for Python-script checks. These prerequisites are installed in the fleet
runner image.

`repo-validation.yml` uses this action, so registered consumer repositories can
set its `runs-on` input to their socketless fleet pool. The workflow installs
`xz-utils` with passwordless sudo/apt when an older worker lacks xz. Keep GitHub-hosted
routing for fork pull requests. Secret scanning can use the same setup action
without changing its check name, commit range, redaction or repository config.

`repo-validation.yml` also runs repo-tools' `repo-check-runner-labels` at a
pinned commit, in its own GitHub-hosted `runner label combinations` job so it
still reports when the caller's validation pool is itself misrouted; the
required `repository validation` job fails unless that job succeeded. It fails when a job's `runs-on` pairs `self-hosted` with a label
the caller declares under `self-hosted-runner.labels` in
`.github/actionlint.yaml`: fleet labels are runner scale sets, which match only
their own name, so that combination never schedules. Declaring the repo's pool
labels there is the opt-in; a caller with no declared labels gets a no-op. Set
`check-runner-labels: false` only for classic runners that carry both labels.

It runs repo-tools' `repo-check-schedules` the same way, in a GitHub-hosted
`schedule justifications` job that the required `repository validation` job
also requires. Every systemd timer, workflow cron or Kubernetes CronJob in the
caller's tracked files that fires more often than hourly needs an adjacent
`# schedule-justification: <reason>` comment; frequent polling usually means
the design should react to an event instead. The job prints the caller's full
inventory of sub-hourly schedules. `check-schedules: false` turns it off.

## Contract verification

`published-actions.contract.test.mjs` verifies each Published composite
action's declared inputs and outputs. Modify its manifest with every deliberate
surface change. Reusable workflows are verified through actionlint; review
their `workflow_call` surfaces as public API.

## Related documents

| Topic                            | Document                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| Dispatch and worker ownership    | [Agent dispatch ownership](lifecycle-systems.md)                                     |
| Credential and variable boundary | [Deployment boundary](deployment-boundary.md)                                        |
| Fleet protocol                   | [Agent protocol](../agents/shared/skills/agent-protocol/reference/agent-protocol.md) |
| Workstation agent tools          | `packages/fleet-tools/`                                                              |
