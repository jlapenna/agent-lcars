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

| Action                  | Purpose                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `mint-agent-token`      | Mint a scoped Agent LCARS App installation token.                  |
| `assert-repo-vars`      | Report all missing required repository variables.                  |
| `merge-live-base`       | Merge the live base into a PR head before validation.              |
| `setup-nx-remote-cache` | Configure trusted Nx jobs for the shared L2 cache.                 |
| `deploy-verify`         | Poll a deployed URL and optionally annotate deployment status.     |
| `request-control-plane` | Send an OIDC-authenticated request and expose its single response. |

## Published reusable workflows

| Workflow                       | Purpose                                          |
| ------------------------------ | ------------------------------------------------ |
| `renovate-auto-approve.yml`    | Approve a Renovate PR with a minted App token.   |
| `agent-automerge-reusable.yml` | Arm auto-merge and restore the post-merge chain. |
| `repo-validation.yml`          | Run actionlint for a caller repository.          |
| `codeql-reusable.yml`          | Run the caller-configured CodeQL analysis job.   |

Hosted provider workflows are retired; providers execute through the Console
QueueExecutor instead.

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

`request-control-plane` exposes the exact response body through its `response`
output for a successful bodyless or `payload` request. Batch `payloads` mode
has no singular response, so its output is empty. The action does not parse or
assign endpoint-specific meaning to either response shape. During #1633's
additive migration, member automation uses that generic transport with the
Work API's `/dispatches/github` endpoint and `agent-lcars-work` audience; the
generated Work OpenAPI contract, not this transport action, defines the
dispatch payload and response. A GitHub dispatch may send GitHub's complete
valid anchor body (including an empty body). The service preserves non-empty
bodies that already fit the Work description limit exactly, and normalizes
empty or oversized bodies with the shared Work byte-budget/truncation rule
before authorization or storage; callers must not pre-truncate it.

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
