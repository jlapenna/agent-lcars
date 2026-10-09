# Agent dispatch: operational ownership

Use this document to identify the owning system when an agent dispatch fails.
It describes the current orchestrator; historical dispatch implementations are
available through Git history.

## Ownership

| System          | Owns                                                                          | Source                                                           |
| --------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Orchestrator    | Per-task admission, leases, dispatch/outcome outbox, and reconciliation.      | `libs/orchestrator/`, `apps/console/src/lib/orchestrator-*.ts`   |
| Runner platform | Direct-runner launch capacity, host readiness preflight, and loss recovery.   | `apps/runner-autoscaler/`; live configuration belongs to Homelab |
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
5. A lease is renewed while the run is live. When a worker terminates
   without reporting, the QueueExecutor reports the exit and the run is
   settled `lost` at once; reconciliation settles expired leases as the
   backstop. Claims that never deliver a first heartbeat have a separate
   fifteen-minute startup deadline (normally settled within twenty minutes
   by the five-minute maintenance tick), followed by the same bounded retry.
   Normal executor recovery retires the exact settled claim's original Job
   with guarded foreground deletion; admission waits for its owned Pods to
   drain. Expiry alone is not deletion authority. Both perform bounded retry; an exhausted retry budget parks the
   task for manual action.

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
| Task is silent or appears stuck                           | Reconciliation         | QueueExecutor `maintenance tick` logs and the tick response          |
| Console Retry fails                                       | GitHub Work admission  | `github-work-admission.ts` and `backend-actions.ts` mutation         |

## Runner platform boundary

Every GitHub Actions runner lane runs on Actions Runner Controller (k3s,
homelab#1623); `apps/runner-autoscaler`'s own GitHub scale-set runner
management was retired in that issue's Phase 3. What remains:

- `agent-lcars` owns the LCARS QueueExecutor's provider configuration and
  direct-runner image (not a GitHub-registered runner).
- Homelab owns the queue's Kubernetes deployment (`orchestrator.yml`'s
  `kubernetes` stanza: namespace, RBAC, node labels, Secret values, and
  sizing), credentials, and the running queue-executor process, plus the
  separate ARC `AutoscalingRunnerSet` configuration for GitHub Actions runner
  lanes. Kubernetes Jobs are the queue executor's only backend.
- A Homelab configuration change requires a queue-executor restart; an Agent
  LCARS change cannot provision missing capacity.

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
| Agent label vocabulary    | [GitHub label contract](github-label-contract.md)               |
| Fleet-consumable actions  | [Published actions](published-actions.md)                       |
| Variables and credentials | [Deployment boundary](deployment-boundary.md)                   |
