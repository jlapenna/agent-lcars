# Hosted control-plane soak and legacy retirement

This runbook is the exit gate for the hosted dispatch-controller migration.
It prevents an open-ended "during soak" exception from preserving a second
production event queue indefinitely. Firestore in the dedicated
`dispatch-controller` database remains the only authority throughout; the
GitHub ledger comment is a non-authoritative compatibility projection.

## Retirement decision

There will be no live break-glass transport for ordinary production intent,
completion, or reconciliation after this soak passes. Recovery from a hosted
regression is a reviewed roll-forward or deployment of the last known-good
App Hosting revision. Restoring a legacy workflow requires a reviewed code
change under an incident; it is not an operator-selectable parallel queue.

The no-op dispatch canary remains a deliberately narrow exception while it is
the only cheap end-to-end proof of dispatch binding plus hosted completion. Its
manual router surface must accept only `kind=canary`, must run on GitHub-hosted
compute, and must not accept a production pipeline, reply, runbook, completion
payload, or reconciliation request. It is a diagnostic transport, not a
production break-glass path. The GitHub App ingress canary independently proves
the real production entry path.

This final topology implies:

- scheduled and manually requested reconciliation use only the hosted
  `/api/control-plane/reconcile` endpoint;
- `action-fallback` is removed;
- `agent-router.yml` is constrained to the dedicated no-op canary and no
  longer depends on `CONTROL_PLANE_RUNNER_LABEL`;
- the canary's database-confined WIF writer remains owned until the canary is
  replaced, but unused runner variables and Action operations are removed when
  repository-wide search proves they have no owner; and
- webhook admission, hosted reconciliation, canary dispatch, and worker
  completion all serialize through the same authoritative Firestore task.

## Continuous soak gate

The minimum window is 24 continuous hours after both the latest controller
revision becomes ready and the bounded rollback drill has restored hosted
authority. A later controller deployment, unexplained control-plane failure,
authority/projection divergence, stuck Cloud Task, or unplanned use of a
legacy transport resets the clock. A diagnostic rerun cannot replace a missing
scheduled run.

The window passes only when all of the following are true:

1. At least 24 consecutive scheduled `webhook-ingress-canary.yml` runs pass.
   Each must bind the exact subscribed GitHub App delivery to its timeline
   source and authoritative controller transport ID.
2. At least 48 consecutive scheduled `dispatch-reconcile.yml` hosted scans
   pass. Every response must report `failed: []`.
3. At least 24 consecutive scheduled `dispatch-canary.yml` runs pass. These
   prove immutable dispatch/run binding and the hosted completion endpoint;
   they do not substitute for the ingress canary.
4. At least one maintainer-authorized `status:ready-for-agent` issue has crossed
   real hosted admission, launched its real worker workflow, delivered a valid
   outcome, and converged without a second generation. A synthetic no-op run
   does not satisfy this gate.
5. Every open controller candidate has `projection.state=converged`, matching
   desired and observed revisions, and no unexplained anomaly. Reconciliation
   has no per-candidate failure.
6. `dispatch-webhooks` is `RUNNING`, contains no task older than five minutes,
   and is empty after the last observed delivery drains. The hosted webhook,
   processor, reconcile, and completion routes have no unexplained non-2xx
   response or severity-error log during the window.
7. No control-plane workflow alert remains open and neither legacy transport
   is used after the recorded restoration.

Record exact run URLs, timestamps, response JSON, ledger revisions, queue
depth, and log-query boundaries in the issue's single progress comment. A
green workflow conclusion without those underlying values is insufficient.

## Bounded rollback drill: 2026-08-08

The drill used open maintenance issue #797, whose one Codex generation had
already completed. The expected transition was a serialized, idempotent read
and projection refresh against the existing Firestore authority: no new
authorization, generation, or worker run.

- Trigger: manual `agent-router.yml`, `kind=reconcile`, issue `797`, run
  [31276840561](https://github.com/jlapenna/agent-lcars/actions/runs/31276840561),
  started `2026-08-08T20:24:48Z`.
- Result: `normalize` and `broker` passed; the broker authenticated through
  the database-confined WIF identity, verified task concurrency
  `agent-lcars-dispatch-v1-1307149765-797`, and applied the authority-mode
  transition.
- Invariant: #797 remained generation `g1`, completed by Codex run
  [31276532506](https://github.com/jlapenna/agent-lcars/actions/runs/31276532506).
  No later Codex run was created, its anomaly list remained empty, and the
  projection converged at the same accepted generation.
- Restoration: manual hosted reconciliation run
  [31276875051](https://github.com/jlapenna/agent-lcars/actions/runs/31276875051)
  returned `{"candidates":114,"dispatched":114,"failed":[],"openCandidates":2,"closedCandidates":112}`
  at `2026-08-08T20:26:15Z`; `action-fallback` was skipped.
- Post-restoration: #797 reported projection desired/observed revision
  `13/13`, zero anomalies, and only its original completed generation. The
  hosted revision durably queued 86 resulting GitHub webhook writes and
  completed all 86; the Cloud Tasks queue drained to zero with no HTTP 4xx/5xx
  or severity-error entry in the bounded post-drill log window.

The continuous soak baseline is therefore `2026-08-08T20:26:15Z`, on App
Hosting/Cloud Run revision `agent-lcars-build-2026-08-08-027`. The earliest
possible exit is `2026-08-09T20:26:15Z`; retirement must not merge before the
scheduled-run and runtime evidence above is complete.

## Evidence collection

Use read-only queries while the window is open:

```sh
gh run list --workflow=webhook-ingress-canary.yml --event=schedule \
  --json databaseId,createdAt,updatedAt,status,conclusion,url
gh run list --workflow=dispatch-reconcile.yml --event=schedule \
  --json databaseId,createdAt,updatedAt,status,conclusion,url
gh run list --workflow=dispatch-canary.yml --event=schedule \
  --json databaseId,createdAt,updatedAt,status,conclusion,url

gcloud tasks list --project=agent-lcars --location=us-central1 \
  --queue=dispatch-webhooks
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="agent-lcars"' \
  --project=agent-lcars
```

For each candidate issue, inspect the authoritative projection through its
`<!-- agent-lcars:dispatch-ledger:v1 -->` compatibility comment and correlate
it with the hosted reconcile result. Do not write Firestore directly to prove
the migration; the controller's own authenticated paths are the test.

## Retirement and rollback verification

After the gate passes, merge the constrained topology through the normal PR
and automatic deployment path. Then:

1. run the real webhook-ingress E2E and require exact delivery/source binding;
2. run hosted reconciliation and require `failed: []`;
3. run the canary-only router and require a single successful no-op generation
   plus hosted completion convergence;
4. send one relevant `status:ready-for-agent` issue through hosted admission
   and its real worker, then verify its final deliverable and ledger;
5. prove the Cloud Tasks queue drains and the post-deploy log window has no
   unexplained non-2xx response, authority gap, projection divergence, or
   severity error; and
6. confirm repository-wide search has no `action-fallback`, production router
   input, or unowned `CONTROL_PLANE_RUNNER_LABEL` reference.

If any check fails, stop retirement and roll forward. Do not switch ordinary
events to the canary-only router or reintroduce Action reconciliation through
a mutable repository setting.
