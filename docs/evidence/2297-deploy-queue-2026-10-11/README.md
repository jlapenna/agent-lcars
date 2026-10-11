# Deployment queue delivery qualification, 2026-10-11

This read-only receipt advances [#2297](https://github.com/jlapenna/agent-lcars/issues/2297).
The queue correction already landed in [PR #2298](https://github.com/jlapenna/agent-lcars/pull/2298)
as `cd343ec6348285901b7e78ee84b1ecc46f490b26`. This observation changes no
workflow or production state. Current policy belongs to
[deployment-boundary.md](../../deployment-boundary.md).

## Existing source qualification

The admitted deploy job uses `queue: max` and `cancel-in-progress: false`.
The in-lock source guard still rejects stale automatic sources before checkout
or credentials. Explicit manual semantics and recovered-CI fencing remain.
Up to 100 pending jobs are retained in arrival order; additional arrivals are
canceled when full. Arrival order does not establish commit freshness.

PR #2298 records independent review of exact head
`f33ab6011694b077a7ca42b3d4b09b37de688a9f`, 32 owning contracts,
eight invalid configuration mutations and unrelated actionlint fixtures.
The owning source-fence test models B and A waiting behind active X and
executes the actual source guard: B is admitted, stale A is rejected.
These are source/model proofs, not an observed GitHub occupied-lock experiment.

## Fresh automatic delivery evidence

Read-only Actions inspection confirmed correction-containing source
`a9324dd910e3ed7cccf3599c1e5bc85e51bba403`:

- [Main CI 38102934745](https://github.com/jlapenna/agent-lcars/actions/runs/38102934745)
  completed actual `Full verification` successfully, followed by `Verify`.
- [Automatic deployment 38103949410](https://github.com/jlapenna/agent-lcars/actions/runs/38103949410)
  is a `workflow_run` event. Its gate explicitly admitted CI 38102934745;
  the in-lock source step passed and checkout printed `HEAD is now at a9324dd`.
- The managed rollout uploaded archive
  `gs://firebaseapphosting-sources-611425338852-us-central1/agent-lcars--413-Aedqk1mOrRk2-.zip`.
  Exact archive resolution produced `build-2026-10-11-003`.
- Actual serving verification at 02:14:41 UTC logged
  `attempt 1/10: https://lcars.jlapenna.net -> 307` and passed.

The related [source-order receipt](../2292-deploy-source-order-2026-10-11/README.md)
records the same rollout and an actual stale source rejected in run 38103095693. The 307 proves the workflow's serving smoke boundary, not an
authenticated browser journey or independent Cloud Run traffic attribution.

## Gates retained on the anchor

Normal automatic rollout now has exact source/archive/build/serving evidence.
It does not prove the live X/B/A occupied-lock ordering: the observed wait
between gate and deployment does not identify the lock occupant or queue.
No live scheduler experiment or manual deployment was performed or authorized.

The owner's issue comment records rules suite 4456180482 as an administrator
bypass with required checks failing for PR #2298. Later full main CI and
serving success do not erase that incident. This dispatch's read-only rules
suite request returned HTTP 403 (`Resource not accessible by integration`),
so it cannot independently requalify the original protected merge.

Keep #2297 open for occupied-lock qualification and reconciliation of the
original protected-delivery requirement. Any additional live experiment
requires the specific maintainer authorization prescribed by repository
policy; ordinary automatic delivery can continue to be observed read-only.
