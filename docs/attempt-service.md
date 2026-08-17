# Lifecycle Control Plane v1 design (superseded)

> [!IMPORTANT]
> **This design was never built, and won't be.** It's kept only because
> other docs still link to it.

Issue [#1019](https://github.com/jlapenna/agent-lcars/issues/1019) proposed
a purpose-built, cross-repository **Lifecycle Control Plane**: a central
service owning generic signal deduplication, task state, authorization-policy
evaluation, ordering/supersession, desired intent, attempt
admission/retry/parking, launch, binding, credential grants, terminalization,
and convergence — with every consumer repository (this one, `sprinkles`,
`homelab`) reduced to a thin Actions execution adapter. It specified opaque
service-minted `attemptId`s, a `LifecycleControlPlaneStoragePort` distinct
from any existing store, a shadow-then-authoritative activation model per
tenant/lane, and a phased migration ending with "no router, reconciler,
controller, finalizer, or projector decision loop remains in a consumer
repo."

That scope — a multi-tenant service, its own storage product, and a
cross-repo migration — was never approved or built. What replaced it instead
is narrower and already shipped: [`libs/orchestrator`](../libs/orchestrator),
a durable **per-task mutex** local to this repository (#1171 and the rest of
#1015's waves; see [`docs/lifecycle-systems.md`](lifecycle-systems.md) for
the current operational picture). It keeps this design's one genuinely load-
bearing idea — attempt admission needs a durable, race-free lock, not a
GitHub concurrency group — and drops the rest: no multi-tenant service, no
opaque cross-repo `attemptId`, no shadow/authoritative activation machinery,
no consumer-repo migration. `Task`/`Run` mutual exclusion is enforced by a
Firestore compare-and-set on one document, not by a bespoke storage port; a
lost run's retry is bounded and immediate, not a policy-driven admission
decision.

If a future need for genuinely cross-repository (not just cross-lane)
dispatch authority reappears — the "Group A" forked brokers in
[`docs/consumer-lifecycle-inventory.md`](consumer-lifecycle-inventory.md)
were the concrete case until homelab#660 retired them onto the central
orchestrator — start from what the orchestrator actually does
(`libs/orchestrator/src/model.ts`, `decide.ts`) and what it deliberately
doesn't (queueing, exactly-once, result adjudication — see
`libs/orchestrator/README.md`), not from this document. Multi-tenancy,
opaque service-global IDs, and a shadow-activation rollout are real problems
this document thought hard about; none of that thinking has been validated
against a real second consumer, so treat it as raw material for a future
design, not a spec to implement as written.

## Where the current design lives

- [`libs/orchestrator/README.md`](../libs/orchestrator/README.md) — purpose,
  the three collections, decision layer, leases/loss/auto-retry, and what it
  does not do.
- [`libs/orchestrator/src/model.ts`](../libs/orchestrator/src/model.ts) — the
  `Task`/`Run`/`OutboxEntry` schemas and their invariants.
- [`libs/orchestrator/src/decide.ts`](../libs/orchestrator/src/decide.ts) —
  the pure decision logic (`requestRun`, `confirmDispatch`, `renewLease`,
  `reportResult`, `cancelRun`, `expireLease`).
- [`docs/lifecycle-systems.md`](lifecycle-systems.md) — operational ownership
  and runbooks for the system this design was meant to replace, as it
  actually exists today.
