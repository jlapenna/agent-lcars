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

| Action                   | Purpose                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `mint-agent-token`       | Mint a scoped Agent LCARS App installation token.                  |
| `prepare-agent-dispatch` | Write routed issue context for a headless agent.                   |
| `verify-deliverable`     | Require an exact attempt marker on a deliverable artifact.         |
| `assert-repo-vars`       | Report all missing required repository variables.                  |
| `merge-live-base`        | Merge the live base into a PR head before validation.              |
| `setup-nx-remote-cache`  | Configure trusted Nx jobs for the shared L2 cache.                 |
| `deploy-verify`          | Poll a deployed URL and optionally annotate deployment status.     |
| `request-control-plane`  | Send an OIDC-authenticated request and expose its single response. |

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

| Tier     | Names             |
| -------- | ----------------- |
| Internal | `setup-node-pnpm` |

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
- A run succeeds only when `verify-deliverable` finds its exact
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
assign endpoint-specific meaning to either response shape.

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
