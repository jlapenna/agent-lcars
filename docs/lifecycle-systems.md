# Agent dispatch: operational ownership

Use this document to identify the owning system when an agent dispatch fails.
It describes the current orchestrator; historical dispatch implementations are
available through Git history.

## Ownership

| System          | Owns                                                                          | Source                                                           |
| --------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Orchestrator    | Per-task admission, leases, dispatch/outcome outbox, and reconciliation.      | `libs/orchestrator/`, `apps/console/src/lib/orchestrator-*.ts`   |
| Runner platform | Worker capacity, registration, placement, readiness, and loss recovery.       | `apps/runner-autoscaler/`; live configuration belongs to Homelab |
| Worker runtime  | Bootstrap, agent invocation, credential separation, and deliverable evidence. | Agent workflows and `.github/actions/`                           |

## Dispatch contract

1. A webhook request creates a task-scoped run only when no live run exists.
   Duplicate or concurrent requests are refused rather than queued.
2. The orchestrator records the decision atomically and enqueues a
   `dispatch-run` outbox entry. The outbox calls `workflow_dispatch` with the
   trusted run identity.
3. The worker uses that identity, runs its bootstrap and agent lane, then
   reports completion through the OIDC-authenticated completion route.
4. A successful worker run must satisfy `verify-deliverable`: an artifact
   contains its exact `<!-- attempt-claim:<attempt-id> -->` marker.
5. A lease is renewed while the run is live. Reconciliation settles terminal
   GitHub runs or expired leases, then performs bounded retry; an exhausted
   retry budget parks the task for manual action.

## Code map

| Need                                                | Source                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Task/run schemas and invariants                     | `libs/orchestrator/src/model.ts`                                                              |
| Admission, renewal, reporting, cancellation, expiry | `libs/orchestrator/src/decide.ts`                                                             |
| Atomic store integration                            | `libs/orchestrator/src/orchestrator.ts` and `store.ts`                                        |
| Webhook interpretation                              | `apps/console/src/lib/orchestrator-ingest.ts`                                                 |
| Workflow dispatch and outcome comments              | `apps/console/src/lib/orchestrator-dispatch.ts`                                               |
| Hosted dependencies and routes                      | `apps/console/src/lib/orchestrator-runtime.ts`, `apps/console/src/app/api/control-plane/`     |
| Terminal workflow-run recovery                      | `apps/console/src/lib/orchestrator-terminal-runs.ts`                                          |
| Worker lanes                                        | `.github/workflows/{claude,codex,opencode,agent-lane-*}.yml`                                  |
| Bootstrap and gates                                 | `.github/actions/dispatch-bootstrap`, `verify-deliverable`, and `agent-fallback-finalize.yml` |

## Diagnose by symptom

| Symptom                                                   | Owner                  | First check                                                               |
| --------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------- |
| Correct `agent:*` label; no dispatch or admission record  | Orchestrator admission | GitHub App delivery history, then webhook route and Cloud Tasks logs      |
| Webhook acknowledgement followed by a queued 4xx/5xx      | Orchestrator admission | App Hosting logs for HMAC, payload interpretation, or store failure       |
| Worker job remains queued                                 | Runner platform        | Repository runner registration for the exact `runs-on` label              |
| Failure before the agent step                             | Worker bootstrap       | Failing job step before `Run Claude Code`, `Run Codex`, or `Run OpenCode` |
| Provider, model, or agent failure                         | Worker runtime         | Agent-step log                                                            |
| Agent exits zero without deliverable evidence             | Worker runtime         | `verify-deliverable` log and the expected attempt marker                  |
| Failed worker has no outcome comment                      | Completion path        | `agent-fallback-finalize.yml`, then completion-route logs                 |
| Completion reports success but no outcome comment appears | Outbox drain           | Pending/failed outbox entries from completion or reconcile response       |
| Task is silent or appears stuck                           | Reconciliation         | `dispatch-reconcile.yml` history and reconcile response                   |
| Console Retry/Reassign fails                              | Console command path   | `backend-actions.ts` mutation and reconcile notification                  |

## Runner platform boundary

- `agent-lcars` owns the runner labels used by its workflows.
- Homelab owns the scale-set configuration, credentials, host placement, and
  running autoscaler process.
- For a queued job, confirm a registered runner has the exact requested
  label, then compare Homelab's running scale sets with its configuration.
- A Homelab configuration change requires its supported reload or restart;
  an Agent LCARS change cannot provision missing capacity.

Read [Autoscaler onboarding](onboarding-autoscaler.md) before changing a
registration or its ownership boundary.

## Worker runtime boundary

- Agent workflow callers delegate execution to their same-repository lane.
- `dispatch-bootstrap` receives the admitted run identity; it does not
  re-admit the task.
- The agent does not receive `github.token`. It receives its own App token,
  separate telemetry credentials, and only the explicitly scoped rerun token
  when configured.
- `agent-fallback-finalize.yml` runs on GitHub-hosted infrastructure so an
  early worker failure can still report a completion observation.
- Deliverable evidence is a post-agent gate, not an orchestrator judgement.

See [Published actions](published-actions.md) for consumption and gate
contracts, and [Deployment boundary](deployment-boundary.md) for credential
and runner-variable ownership.

## Related documentation

| Topic                     | Document                                                        |
| ------------------------- | --------------------------------------------------------------- |
| Orchestrator design       | [`libs/orchestrator/README.md`](../libs/orchestrator/README.md) |
| Runner registrations      | [Autoscaler onboarding](onboarding-autoscaler.md)               |
| Agent label vocabulary    | [GitHub label contract](github-label-contract.md)               |
| Fleet-consumable actions  | [Published actions](published-actions.md)                       |
| Variables and credentials | [Deployment boundary](deployment-boundary.md)                   |
