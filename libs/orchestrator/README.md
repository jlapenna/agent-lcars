# @agent-lcars/orchestrator

A durable **per-task mutex with an audit trail** for agent dispatch. See
[`docs/lifecycle-systems.md`](../../docs/lifecycle-systems.md) for how this
fits into the rest of the fleet, and
[`docs/attempt-service.md`](../../docs/attempt-service.md) for the larger,
never-built design this replaced.

## Purpose

A task is a GitHub issue or PR someone wants worked. A run is one execution
of it. The one invariant the orchestrator owns is that a task never has two
live runs at once — a request while a run is live is refused (or, for a
retried delivery of the same request, returns the existing run), never
queued. It takes no view of what a run produced: results are recorded
verbatim and judging them belongs to the task, not the orchestrator. A task
may be worked any number of times, sequentially. See `src/model.ts`'s own
header comment for the full statement of scope.

## The three collections

- **`Task`** — the mutex itself. `activeRunId` is set iff a run is live;
  `runCount` mints the next run's ID; `consecutiveLost` drives the
  auto-retry budget (see Leases, below).
- **`Run`** — one execution's full lifecycle: `pending` (decided, dispatch
  not yet confirmed) → `running` (dispatch confirmed or first report
  received) → a terminal state (`finished`, `canceled`, or `lost`). Every
  transition is appended to `events`, so a run's history is fully
  reconstructable from the document itself.
- **`OutboxEntry`** — effects that must survive the transaction that decided
  them (`dispatch-run`, `report-outcome`). A decision and its side effect
  are never committed in one step; a separate drain worker claims and
  delivers pending entries. See `apps/console/src/lib/orchestrator-dispatch.ts`
  for the real drain (GitHub `workflow_dispatch` + issue comments).

## The decision layer

`src/decide.ts` is pure: given current state and one input (`requestRun`,
`confirmDispatch`, `renewLease`, `reportResult`, `cancelRun`, `expireLease`),
it produces the next state and any outbox effects — no I/O, no clock reads,
no randomness. Every function returns either a `Decision` or a `Refusal`; a
refusal is a normal outcome, not an error — "this task is already being
worked" is the orchestrator doing its one job. `src/orchestrator.ts`'s
`Orchestrator` class is the only place I/O and time meet that pure layer:
read → decide → apply, with one retry on a lost compare-and-set.

## Leases, loss, and bounded auto-retry

A live run must renew its lease (2 hours) or be presumed `lost` —
`expireLease` is the only judgement the orchestrator makes about execution,
and its only meaning is that the task's lock is released so it isn't wedged
forever. `Orchestrator.sweepExpired()` (driven by a scheduled reconcile call,
not by this library) settles every expired run, then immediately requests a
fresh run for each task that hasn't gone `lost` more than `MAX_AUTO_RETRIES`
(2) times in a row since its last `finished`/`canceled` settlement, using a
deterministic `retry:<lostRunId>` request ID so a re-swept or re-driven
retry maps to the run already created instead of starting a second one. Past
that budget the task is left parked for a manual request. A known,
documented gap: a crash between the expire commit (already durable) and the
retry request is not itself durable — see `Orchestrator.sweepExpired`'s own
doc comment for the accepted tradeoff.

## The store contract

`src/store.ts`'s `OrchestratorStore` interface is the durability boundary:
one method per question the decision layer asks, one `apply` to commit a
decision atomically, keyed on the task's revision so two racing writers
cannot both take the lock (`StoreConflict`). `src/store-contract.ts` defines
one behavioral test suite against that interface; `src/store-contract.spec.ts`
runs it against both implementations:

- **`MemoryStore`** (`src/memory-store.ts`) — the reference implementation
  and the default test double. In-process, no I/O.
- **`FirestoreStore`** (`src/firestore-store.ts`) — the real backend.
  Collections default to `orchestrator-{tasks,runs,outbox}` (configurable
  prefix, used by tests to avoid collisions in a shared emulator).

The `FirestoreStore` half of the contract suite only runs when
`FIRESTORE_EMULATOR_HOST` is set; otherwise it's skipped so the suite still
passes hermetically. Against the repo's Firestore emulator
(`firebase.json`, port 4002):

```sh
FIRESTORE_EMULATOR_HOST=localhost:4002 npx vitest run --project '@agent-lcars/orchestrator'
```

## What this deliberately does not do

- **Adjudicate results.** `RunResult` (`ok`, `summary`, `ref`) is recorded
  verbatim from whatever the caller reports; the orchestrator never
  interprets it.
- **Queue.** A request against a busy task is refused, not enqueued.
  Queueing is a possible follow-up, not a v1 behavior.
- **Guarantee exactly-once dispatch or delivery.** The invariant is mutual
  exclusion — at most one live run per task — not exactly-once execution. A
  lost run's work may have partially landed; the outbox drain retries a
  failed GitHub call until it succeeds, which can mean an outcome comment
  or a `workflow_dispatch` call is attempted more than once for the same
  entry (each is written to be safe under that retry, not to prevent it).
- **Provide multi-tenant or cross-repository authority.** One task is keyed
  by `(repo, issue)`; there is no tenant concept above that. See
  `docs/consumer-lifecycle-inventory.md` for the still-separate dispatch
  loops this does not (yet) cover in other repositories.
