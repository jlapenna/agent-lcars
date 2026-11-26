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
| `setup-repo-checks`     | Install pinned native gitleaks or actionlint without Docker.            |
| `mint-agent-token`      | Mint a scoped Agent LCARS App installation token.                       |
| `assert-repo-vars`      | Report all missing required repository variables.                       |
| `merge-live-base`       | Merge the live base into a PR head before validation.                   |
| `setup-nx-remote-cache` | Configure trusted Nx jobs for the shared L2 cache.                      |
| `deploy-verify`         | Poll a deployed URL and optionally annotate deployment status.          |
| `oidc-post`             | Send an OIDC-authenticated request and expose its single response.      |
| `control-flag`          | Make an engaged fleet control flag visible in logs and the job summary. |

`mint-agent-token` requires at least one explicit `permission-*` input,
including when the requested token only needs `permission-metadata: read`.
Blank or whitespace-only permission sets fail before minting; tokens never
inherit every installation permission through an omitted allowlist. The pinned
GitHub-owned action enforces the permission and repository request and revokes
the actual token after the job. `permission-workflows: write` stays explicit;
unsupported installation grants fail at the native mint. Leaving both target
inputs empty still scopes to the workflow repository; explicitly setting an
owner without repositories intentionally selects that owner's installation.

## The review gate

The review gate is GitHub's own review requirement, the same in every
review-gated repository: `Protect main` sets
`required_approving_review_count = 1` with `dismiss_stale_reviews_on_push`,
and requires review-thread resolution. Nothing in a repository publishes a
review check, and no workflow, secret or marker carries a verdict.

LCARS reviews as an ordinary reviewer. It submits `APPROVE` or
`REQUEST_CHANGES` on the reviewed commit; a `COMMENT` is not a verdict. Every
repository gets the same triggers: a review is dispatched when a non-draft PR
opens, becomes ready, receives a push or is reopened, and a maintainer can
request a fresh one on any PR with `/review`. GitHub dismisses an approval
when the head moves and when the base changes, so no rule here tracks either.

Non-draft Renovate and Dependabot PRs whose commits are all authored by the
bot and signed by GitHub (excluding LCARS's qualification-gated
`renovate/runner-cli-runtimes`, `renovate/major-runner-cli-runtimes`,
`renovate/anthropic-review-workflow`, and
`renovate/major-anthropic-review-workflow` branches) get an approving review
from the control plane, as `agent-lcars-reviewer[bot]`, without a review run. It does
not approve a head that carries `status:needs-human` or `status:blocked`, a
change request, an open trusted review thread, or a dismissed LCARS review.
A commit from anyone else ends the exemption and the PR is reviewed normally.

Compatible runners advertise `X-LCARS-Reviewer-Checkout: v1` on the startup
heartbeat. Console atomically records the dedicated App binding with the first
accepted heartbeat, using an executor event that older releases can read.
Reviews started on an older Console or by a legacy runner stay on the fleet
App for the whole claim. Later heartbeats and checkout requests cannot change
that choice. The startup acknowledgement selects the checkout endpoint for
both the initial grant and renewals. Dedicated reviews use an endpoint absent
from older Console releases and fail closed if the endpoint or the dedicated
credentials are unavailable.

Console also exposes `POST /api/work/v1/runs/{runId}/review` for
run-token-authenticated verdict submission. It accepts an approval or change
request only for the GitHub pull request and full commit SHA recorded for the
live review run bound to the dedicated reviewer. PR webhook and remediation
admission record that SHA. Console
compares it with the live head, stamps the attempt marker and publishes as the
Reviewer App. Legacy and manually admitted runs without a recorded SHA cannot
use this route. The current runner still uses its checkout grant to publish
reviews. Runner migration and removal or exclusion of all worker-held approving
credentials are tracked in [#3595](https://github.com/jlapenna/agent-lcars/issues/3595).

Before rolling back to a Console that predates reviewer binding, stop
QueueExecutor from starting new runs and let active dedicated reviews settle,
or cancel them and verify their run leases are no longer live. Keep new
claims paused through the cutover. If canceling, also verify the workers have
stopped, since already-issued GitHub grants can outlive the LCARS lease.
Resume claims after rollback and request fresh reviews for interrupted heads.
The dedicated App has source, issue, and Actions read access and pull-request
write access. Automatic dependency approvals also use it.
After both components are deployed, `/review` requests a fresh review on the
same head if a legacy self-review comment left a PR waiting for approval. A later
dedicated approval supersedes an older self-review block on that head. GitHub
change requests, unresolved threads, and dismissal vetoes still apply.
On a maintainer-authored PR, a pre-cutover `agent-lcars[bot]` change request
can keep GitHub at `CHANGES_REQUESTED` after a dedicated reviewer approves the
current head. The stale-review sweep skips maintainer-authored PRs. A
maintainer with review-dismissal permission should verify that the current
head addresses the old findings, then dismiss the obsolete fleet App review
on GitHub with that reason. Confirm GitHub counts the current-head approval.
Implementation authors remain unchanged, including `agent-lcars[bot]`, and
GitHub's ordinary approving review counts because author and reviewer differ.
The existing fleet App webhook receives these reviews and wakes auto-merge.
Actions' `can_approve_pull_request_reviews` remains off in every gated repository.

Enabling the gate in a repository is one change to its ruleset root
(`infra/github-ruleset`), applied by Homelab's executor. Before adding it,
remove the `fleet-onboard: managed` marker from that root so later scaffold
refreshes preserve the rule.

## Published reusable workflows

| Workflow                       | Purpose                                             |
| ------------------------------ | --------------------------------------------------- |
| `agent-automerge-reusable.yml` | Arm and reconcile agent and approved PR auto-merge. |
| `repo-validation.yml`          | Run actionlint, runner-label, schedule checks.      |
| `codeql-reusable.yml`          | Run the caller-configured CodeQL analysis job.      |

Hosted provider workflows are retired; providers execute through the Console
QueueExecutor instead.

`reconcile-automerge` arms squash auto-merge on every open, non-draft,
non-parked PR that is either agent-authored (`bot-logins`) or a
same-repository PR whose `reviewDecision` is `APPROVED`, whoever opened it.
Approval is the gate, and most maintainer-login PRs are agent-written
(jlapenna/homelab#3800 sat approved and unarmed). Fork PRs and Renovate or
Dependabot PRs are never armed this way. Adding `status:needs-human` disarms any PR
the sweep could have armed, whoever opened it. The console starts each repository's `agent-automerge.yml` through
`workflow_dispatch` when it receives an approving review of a same-repository,
non-draft PR, so the sweep arms it within minutes. A push to the base branch, a
successful PR CI run and the daily schedule remain the backstop.

`agent-automerge-reusable.yml`'s `reconcile-automerge` job also updates a
BEHIND branch on any open, non-draft, non-parked PR that already has
auto-merge armed (arming auto-merge is the opt-in, except for dependency
bots such as Renovate and Dependabot, which retain branch ownership):
GitHub's own auto-merge arms a PR but never updates its branch, so under a strict "up to date" ruleset a PR whose head falls behind
`main` after another merge stalls indefinitely until a human rebases it
(#1748; jlapenna/homelab#1121 sat 16 hours this way with green checks and
auto-merge armed). The sweep only acts once the checks on the PR head are all green with
none still running and it has no unresolved review thread, re-checks a
stale `UNKNOWN` mergeability up to three times, prefers `gh pr update-branch --rebase`
and falls back to the default merge-commit update if the rebase form is
refused, and is capped at 5 updates per run. GitHub separately enforces the
required check on the test merge commit when it has check results.

The sweep never updates Renovate or Dependabot PRs (#2049). Updating a
Renovate branch with `GITHUB_TOKEN` can suppress follow-up CI and cause
Renovate to treat the branch as externally modified. The shared Renovate
preset sets `rebaseWhen: "auto"` so Renovate handles behind-branch updates
for strict up-to-date rulesets itself. Consumers overriding that setting
with `"conflicted"` must remove the override or use `"behind-base-branch"`.
This leaves branch updates and the resulting CI events under Renovate's
own identity.

The workflow's required `runs-on` input selects the short-lived glue-job
pool. It no longer runs persistent post-merge CI/deploy monitors.

### Auto-merge identity

Set `app-token-enabled: true`, pass `vars.AGENT_LCARS_CLIENT_ID` as
`app-client-id`, and map `secrets.AGENT_LCARS_PRIVATE_KEY` to
`APP_PRIVATE_KEY`. These inputs are required for the supported fleet path. The reusable workflow mints a
short-lived token limited to the current repository and only the permissions
used by its arm or reconcile job. GitHub then performs the merge as the Agent
LCARS App, preserving the normal `push` and `workflow_run` event chain, native
`Closes` handling, and repository branch deletion.

An App-enabled caller must use `pull_request_target`, not `pull_request` or
`pull_request_review`, and must never check out or execute PR-head content in
that workflow. This keeps the private key in workflow code loaded from the
trusted default branch. The reusable arm job rejects App mode on any other PR
event. False or omitted `app-token-enabled` fails configuration validation
before any mutation job runs; it never falls back to a different merge identity.

The caller must also grant its `GITHUB_TOKEN` `statuses: read` alongside
`checks: read`; GitHub's `statusCheckRollup` query fails as a whole when a
commit-status context exists and either scope is missing. Read-only rollup
queries use that token because the fleet App intentionally has no commit-status
grant; mutations continue to use the repository-scoped App token. App-enabled
callers add a `push: [main]` trigger. That first trusted-base run migrates any
still-open agent PR armed by the exact legacy `app/github-actions` identity: it
disables the legacy request and re-arms with the App token under the current App identity. Human and other App arms are preserved. Every
reconciliation run performs the migration; if the cutover PR's own legacy
merge actor suppresses that first push, run the caller once with a plain
`workflow_dispatch`.

The `app-token-enabled` input keeps its false default so an omitted value
fails clearly instead of silently changing a caller's identity. All fleet
callers explicitly enable App mode. The former `GITHUB_TOKEN` recovery jobs
and their inputs are retired: `restore-runs-on`, `ci-workflow`,
`extra-main-workflows`, `post-ci-workflows`, `deploy-workflow`,
`post-deploy-verify-workflow`, `post-submit-enabled`, `check-wait-minutes`,
`restore-timeout-minutes`, `monitor-pr`, `monitor-head-sha`, and
`required-checks`.

An App-enabled caller reconciles on events instead of a short poll: `push` to
main (when an armed PR falls behind) and `workflow_run` `completed` for every
workflow that posts checks on a PR head (when an armed PR turns green; the
reusable admits successful same-repository `pull_request` runs). An approving
review needs no trigger: GitHub's own auto-merge acts on it.
The sweep waits for all checks to pass. App merges and App-pushed PR heads
emit both events. A late thread resolution, a late arm, mergeability still
`UNKNOWN` after the sweep's bounded re-reads, or a transiently failed sweep
emits nothing subscribable, so keep at most a daily `schedule` backstop plus
`workflow_dispatch` for manual repair. Pass no restore-chain inputs.

The caller's workflow-level concurrency may supersede `pull_request_target`
runs only for PRs whose author is in `AGENT_BOT_LOGINS`; every other run keeps
a group unique to its run ID. A superseded run leaves cancelled check runs on
the PR head, and Renovate's own automerge treats any cancelled check run as
pending, so per-PR cancellation on a Renovate PR blocks its merge indefinitely.

## Not consumer surfaces

| Tier     | Names                              |
| -------- | ---------------------------------- |
| Internal | `setup-node-pnpm`, `ci-log-stream` |

## Live CI logs

The internal `ci-log-stream` action makes the long `Full verification` jobs
observable before GitHub publishes its completed log archive. On trusted fleet
runners it tails the runner's already-secret-masked rotating page logs and
pushes them directly to Loki; GitHub-hosted fork jobs cleanly no-op.
The Loki push endpoint comes from the optional `CI_LOG_LOKI_URL` repository
variable (`config/github-variables.json`); the action carries no default, so
leaving it unset disables shipping.

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
valid anchor body (including an empty body). The Work payload budget holds
any complete GitHub body, so the service preserves non-empty bodies exactly.
It normalizes an empty body, and marks and shortens only a body whose
serialized form still exceeds the Work byte budget (possible only with heavy
use of JSON-escaped control characters), before authorization or storage;
callers must not pre-truncate it.

## Native repository checks

`setup-repo-checks` is Published. Set `tool: gitleaks` for Gitleaks 8.30.1,
or `tool: actionlint` for actionlint (optional `actionlint-version`; empty
selects the fleet pin in `runner-image/actionlint-version`), ShellCheck 0.10.0 and Pyflakes 3.2.0. It adds the executables to PATH
on Linux x64/arm64. `tool-source: install` remains the default: it uses a
temporary directory and verified release archives, preserving GitHub-hosted
and fork support and custom actionlint releases. The actionlint toolchain
requires xz to unpack ShellCheck, plus Python 3 and pip. These prerequisites
are installed in the fleet runner image.

`tool-source: baked` validates the selected tools already on PATH: Gitleaks,
or actionlint plus ShellCheck and Pyflakes. Every version must match the
requested actionlint version and shared scanner pins exactly. Missing, broken
or mismatched tools fail before creating a temporary package target or calling
an installer; there is no fallback. Baked mode checks against the pins the
image was built with, `/usr/local/share/agent-lcars-tooling/repo-checks.env`
and, for an empty `actionlint-version`, the sibling `actionlint-version`
(missing fails), not the action's own copies: callers take this action at `@main`
immediately, but a new image only after Homelab republishes it, so a pin bump
would otherwise fail every baked caller until then (#3120). Install mode uses
the downloaded action's siblings
`apps/runner-autoscaler/runner-image/repo-checks.env` and `actionlint-version`,
the shared scanner pin owners.

The runner image source bakes these scanners, with Pyflakes in the root-owned
`/opt/runner-python-tools` venv and executables on ordinary PATH. Callers opt
into baked mode per job; supersprinklesracing/www's secret scan uses it, and
other callers use install mode.

`repo-validation.yml` uses this action, so registered consumer repositories can
set its `runs-on` input to their socketless fleet pool. It forwards optional
`tool-source` (default `install`) to the setup action. Both modes require xz
already on PATH and validate the mode before checking that prerequisite. The
workflow does not invoke sudo or a system package manager. Keep
GitHub-hosted routing for fork pull requests. Secret scanning can use the same
setup action without changing its check name, commit range, redaction or
repository config.

`repo-validation.yml` also runs repo-tools' `repo-check-runner-labels` at a
pinned commit, in its own GitHub-hosted `runner label combinations` job so it
still reports when the caller's validation pool is itself misrouted; the
required `repository validation` job fails unless that job succeeded. It fails when a job's `runs-on` pairs `self-hosted` with a label
the caller declares under `self-hosted-runner.labels` in
`.github/actionlint.yaml`: fleet labels are runner scale sets, which match only
their own name, so that combination never schedules. Declaring the repo's pool
labels there is the opt-in; a caller with no declared labels gets a no-op. Set
`check-runner-labels: false` only for classic runners that carry both labels.

It runs repo-tools' `repo-check-schedules` in a `schedule justifications` job
that follows the caller's `runs-on` input (explicitly provisioning Node 24
without package-manager caching), and the required `repository validation` job
also requires it. Every systemd timer, workflow cron or Kubernetes CronJob in the
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
