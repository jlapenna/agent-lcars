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

| Action                         | Purpose                                                          |
| ------------------------------ | ---------------------------------------------------------------- |
| `mint-agent-token`             | Mint a scoped Agent LCARS App installation token.                |
| `agent-setup`                  | Configure agent Git identity, timestamps, and optional Nx cache. |
| `verify-agent-identity`        | Verify the minted App identity and push credential.              |
| `prepare-agent-dispatch`       | Write routed issue context for a headless agent.                 |
| `setup-opencode`               | Resolve, cache, and install a versioned OpenCode CLI.            |
| `verify-deliverable`           | Require an exact attempt marker on a deliverable artifact.       |
| `report-failure`               | Record failure in the run log for the hosted finalizer.          |
| `snapshot-enforcement-scripts` | Freeze post-agent gate scripts before the agent runs.            |
| `assert-repo-vars`             | Report all missing required repository variables.                |
| `merge-live-base`              | Merge the live base into a PR head before validation.            |
| `setup-nx-remote-cache`        | Configure trusted Nx jobs for the shared L2 cache.               |
| `deploy-verify`                | Poll a deployed URL and optionally annotate deployment status.   |
| `request-control-plane`        | Send an OIDC-authenticated request to a control-plane endpoint.  |
| `validate-worker-workflows`    | Validate worker issue/native-work anchor-union contracts.        |

## Published reusable workflows

| Workflow                                 | Purpose                                          |
| ---------------------------------------- | ------------------------------------------------ |
| `renovate-auto-approve.yml`              | Approve a Renovate PR with a minted App token.   |
| `agent-automerge-reusable.yml`           | Arm auto-merge and restore the post-merge chain. |
| `agent-lane-{claude,codex,opencode}.yml` | Published issue-agent lane contracts.            |
| `repo-validation.yml`                    | Run actionlint and worker-anchor contracts.      |
| `codeql-reusable.yml`                    | Run the caller-configured CodeQL analysis job.   |

The lane shims are the published interface. They delegate to the internal
parameterized `agent-lane.yml`; callers must not call that internal workflow
directly.

## Published script-only contract

`post-agent-gates` is a script, not a composite action. Snapshot it before the
agent runs, then invoke it only with
`bash "$RUNNER_TEMP/trusted-actions/post-agent-gates/post-agent-gates.sh"`.
Do not use it through `uses:` after the agent step.

## Not consumer surfaces

| Tier     | Names                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| Internal | `setup-node-pnpm`, `stamp-attempt-marker`, `agent-handoff`, `archive-opencode-trajectory`                      |
| Coupled  | `dispatch-bootstrap`, `telemetry-start`, `telemetry-finalize`, `resume-session`, `agent-fallback-finalize.yml` |

`agent-fallback-finalize.yml` is a dispatch-protocol component, not a
general-purpose reusable workflow. See [Agent dispatch ownership](lifecycle-systems.md).

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

`validate-worker-workflows` takes no inputs. It reads the caller checkout's
`.github/workflows/{claude,codex,opencode}.yml` files and protects the common
dispatch boundary: the nine-input surface, optional empty `issue` and `work`
anchors, the canonical issue-or-work admission and forwarding for both worker
and fallback, a native-aware run name, and an evaluated native input in any
workflow-level concurrency group. Caller-supplied `prompt` overrides are
rejected so the shared lane owns canonical prompt construction.
Provider-specific credentials, timeouts, lane plumbing, and job-level
concurrency remain caller-owned.

## Security invariants

- Snapshot post-agent gates before invoking an agent. Run them afterward only
  from `$RUNNER_TEMP/trusted-actions`, never from a mutable checkout or a
  post-agent `uses:` resolution.
- Request the narrowest `mint-agent-token` permissions. `permission-workflows`
  is opt-in; see [Agent workflow write permission](agent-workflow-write-permission.md).
- A run succeeds only when `verify-deliverable` finds its exact
  `<!-- attempt-claim:<attempt-id> -->` marker on a deliverable. Progress and
  takeover comments are not deliverables.
- Marker stamping is enabled only for the untrusted agent step. Post-agent
  gates must never enable it, because a gate must not satisfy its own evidence
  check.
- A cross-repository `uses:` download contains the whole referenced repository.
  An action that relies on a sibling path must declare that dependency in its
  manifest.

## Contract verification

`published-actions.contract.test.mjs` verifies each Published composite
action's declared inputs and outputs. Modify its manifest with every deliberate
surface change. Reusable workflows are verified through actionlint and their
workflow-contract tests; review their `workflow_call` surfaces as public API.

## Related documents

| Topic                            | Document                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| Dispatch and worker ownership    | [Agent dispatch ownership](lifecycle-systems.md)                                     |
| Credential and variable boundary | [Deployment boundary](deployment-boundary.md)                                        |
| Fleet protocol                   | [Agent protocol](../agents/shared/skills/agent-protocol/reference/agent-protocol.md) |
| Workstation agent tools          | `packages/fleet-tools/`                                                              |
