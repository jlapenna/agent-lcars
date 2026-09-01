# Agent dispatch: operational ownership

Use this document to identify the owning system when an agent dispatch fails.
It describes the current orchestrator; historical dispatch implementations are
available through Git history.

## Ownership

| System          | Owns                                                                          | Source                                                           |
| --------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Orchestrator    | Per-task admission, leases, dispatch/outcome outbox, and reconciliation.      | `libs/orchestrator/`, `apps/console/src/lib/orchestrator-*.ts`   |
| Runner platform | Worker capacity, registration, placement, readiness, and loss recovery.       | `apps/runner-autoscaler/`; live configuration belongs to Homelab |
| Worker runtime  | Bootstrap, agent invocation, credential separation, and deliverable evidence. | QueueExecutor direct-runner image and native runtime helpers     |

## Dispatch contract

1. A webhook request creates a task-scoped run only when no live run exists.
   Duplicate or concurrent requests are refused rather than queued.
2. The orchestrator records the decision atomically and enqueues a
   `dispatch-run` outbox entry. The outbox writes the run to QueueExecutor's
   claimable queue state; it does not dispatch a GitHub Actions workflow.
3. The QueueExecutor claims that identity, runs the direct-runner bootstrap,
   then reports completion through the Work API run-token route.
4. A successful worker run must satisfy the native deliverable verifier: an artifact
   contains its exact `<!-- attempt-claim:<attempt-id> -->` marker.
5. A lease is renewed while the run is live. Reconciliation settles terminal
   GitHub runs or expired leases, then performs bounded retry; an exhausted
   retry budget parks the task for manual action.

## Code map

| Need                                                | Source                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| Task/run schemas and invariants                     | `libs/orchestrator/src/model.ts`                                                 |
| Admission, renewal, reporting, cancellation, expiry | `libs/orchestrator/src/decide.ts`                                                |
| Atomic store integration                            | `libs/orchestrator/src/orchestrator.ts` and `store.ts`                           |
| Webhook interpretation                              | `apps/console/src/lib/orchestrator-ingest.ts`                                    |
| Queue dispatch and outcome comments                 | `apps/console/src/lib/orchestrator-dispatch.ts`                                  |
| Console dependencies and routes                     | `apps/console/src/lib/orchestrator-runtime.ts`, `apps/console/src/app/api/work/` |
| Provider execution                                  | Console QueueExecutor and the direct-runner image                                |
| Bootstrap and deliverable evidence                  | Native runtime helpers and direct-runner                                         |

## Diagnose by symptom

| Symptom                                                   | Owner                  | First check                                                          |
| --------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| Correct `agent:*` label; no dispatch or admission record  | Orchestrator admission | GitHub App delivery history, then webhook route and Cloud Tasks logs |
| Webhook acknowledgement followed by a queued 4xx/5xx      | Orchestrator admission | App Hosting logs for HMAC, payload interpretation, or store failure  |
| Worker is not claimed                                     | Runner platform        | QueueExecutor health and direct-runner placement                     |
| Failure before the agent step                             | Worker bootstrap       | Direct-runner logs before the provider invocation                    |
| Provider, model, or agent failure                         | Worker runtime         | Agent-step log                                                       |
| Agent exits zero without deliverable evidence             | Worker runtime         | Native verifier log and the expected attempt marker                  |
| Failed worker has no outcome comment                      | Completion path        | Direct-runner completion logs, then Work API logs                    |
| Completion reports success but no outcome comment appears | Outbox drain           | Pending/failed outbox entries from completion or reconcile response  |
| Task is silent or appears stuck                           | Reconciliation         | `dispatch-reconcile.yml` history and reconcile response              |
| Console Retry fails                                       | GitHub Work admission  | `github-work-admission.ts` and `backend-actions.ts` mutation         |

## Runner platform boundary

- `agent-lcars` owns QueueExecutor provider configuration and direct-runner image.
- Homelab owns the scale-set configuration, credentials, host placement, and
  running autoscaler process.
- For a queued job, confirm a registered runner has the exact requested
  label, then compare Homelab's running scale sets with its configuration.
- A Homelab configuration change requires its supported reload or restart;
  an Agent LCARS change cannot provision missing capacity.

Read [Autoscaler onboarding](onboarding-autoscaler.md) before changing a
registration or its ownership boundary.

## Worker runtime boundary

- QueueExecutor direct-runner receives the admitted run identity; it does not
  re-admit the task.
- The agent does not receive `github.token`. It receives its own App token,
  separate telemetry credentials, and only the explicitly scoped rerun token
  when configured.
- Deliverable evidence is a post-agent gate, not an orchestrator judgement.

See [Deployment boundary](deployment-boundary.md) for credential and
runner-variable ownership.

## Related documentation

| Topic                     | Document                                                        |
| ------------------------- | --------------------------------------------------------------- |
| Orchestrator design       | [`libs/orchestrator/README.md`](../libs/orchestrator/README.md) |
| Runner registrations      | [Autoscaler onboarding](onboarding-autoscaler.md)               |
| Agent label vocabulary    | [GitHub label contract](github-label-contract.md)               |
| Fleet-consumable actions  | [Published actions](published-actions.md)                       |
| Variables and credentials | [Deployment boundary](deployment-boundary.md)                   |
