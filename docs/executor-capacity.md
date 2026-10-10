# Application-owned executor capacity

The application receipt protocol is implemented by `CapacityProtocol` in
`libs/orchestrator/src/capacity.ts`, the owning persisted schemas in
`capacity-model.ts`, and the Work API contracts in
`libs/work/src/capacity-contract.ts`. This is the application boundary for
[#2311](https://github.com/jlapenna/agent-lcars/issues/2311). Receipt-aware
Kubernetes execution belongs to
[#2312](https://github.com/jlapenna/agent-lcars/issues/2312); declared hosts,
identity trust roots, fencing, staging failure injection and an approved
production canary belong to
[Homelab #2245](https://github.com/jlapenna/homelab/issues/2245).
Application tests do not establish deployed failover or physical Kubernetes
termination. The reviewed design is
[#2313](https://github.com/jlapenna/agent-lcars/pull/2313).

## Authority and disabled rollout

`AGENT_LCARS_CAPACITY_ENABLED` defaults to disabled; only the literal `true`
enables lifecycle and activation API requests. No deployment setting or live
grant is changed by publishing this implementation. Preparing or enabling
production policy, identity trust roots, import or executor replicas requires
the separately scoped operation approval in the deployment boundary.

The server's `AGENT_LCARS_WORK_GRANTS` may declare `capacityPool` on a verified
principal. The caller cannot select a pool or provider domain in its claim.
The pool policy maps its authorized pipelines to capacity domains. Shared
credentials/backends must use one global domain across every pool. Codex and
OpenCode domain ceilings cannot exceed the existing server-owned ceiling of
one. Unknown reviewed inventory in any enforced pool blocks admission into
its shared domains. Conflicting domain ceilings are refused.

| Grant scope                                  | Authority                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `work.executor` with `capacityPool`          | Register an incarnation and claim from that pool's allowed pipelines                             |
| `work.capacity.recover` with `capacityPool`  | Receipt recovery, inventory attestation, exact worker retirement, and owned lifecycle operations |
| `work.capacity.fence` with `capacityPool`    | A separately configured positive fencing authority may close an exact other producer incarnation |
| `work.capacity.operator` with `capacityPool` | Declare pool policy and review/import migration inventory                                        |

None of these scopes changes the existing executor-exit route: that route
still requires the original authenticated claimant subject and runner name.
An ordinary executor cannot attest a Pod or claim another producer is dead.
An ordinary Work operator does not gain capacity operator or fencing power.

## Atomic claim and durable replay

Register a unique process incarnation with `POST /runs/capacity`, action
`register`, before claiming. `POST /runs/claim` then requires `runner`,
`capacityVersion`, `producerId`, and a caller-generated `claimRequestId`.
All paths here are relative to `/api/work/v1`.

One MemoryStore or Firestore transaction selects eligible work, applies
cooldown/deferred eligibility and provider fairness, checks global provider
occupancy, and commits the run claim, fixed pool slot, unplaced allowance and
replay record. Capacity is the deduplicated union of physical receipts and
legacy claims, including logically terminal claims whose workers remain
uncertain. No logical lease, completion, loss, recovery lease or process
timeout releases a slot or a provider domain. One initial unplaced receipt
per pool is allowed; only positively attested placement releases that
allowance.

The receipt reply contains the exact pool, slot, revision, run and nonce fence
plus the deterministic Job name. Clients must retain that fence for every
lifecycle operation.

| Reply discriminator               | Meaning                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `claim`                           | First response contains the newly minted run token and exact receipt                                                               |
| `recover-owned-secret`            | The same attempt has an attested immutable owned Secret; read that exact Secret identity, with no newly minted/reconstructed token |
| `quarantined-unrecoverable-token` | No recoverable immutable Secret/live token exists, or the attempt has retired; preserve occupancy and follow physical retirement   |
| `wait`                            | No eligible queue head or no physical capacity; no run was claimed                                                                 |

The request record stores only a token hash. It cannot reconstruct a secret.
An identical retry cannot claim another run; a different request ID cannot
bypass an unresolved producer claim lacking an owned Secret. A closed
incarnation cannot register again. GitHub implementation work whose current
lifecycle cannot be verified is quarantined before returning a token; a
confirmed closed anchor is also logically canceled. Neither operation frees
physical occupancy.

## Exact lifecycle and worker permits

Lifecycle requests use `POST /runs/capacity` with the generated discriminated
command schema. `recover` acquires a receipt-bound nonce for at most 60
seconds. Expiry changes who may investigate, never physical capacity.
`purpose: retire` permits continuation of retirement investigation after a
previous retirement owner's lease expires; it does not permit activation or
resuming a retired attempt.

1. `bind` validates the exact deterministic Job name/UID, nondeleting owned
   inventory, and optional immutable Secret UID/token hash. Placement requires
   the inventory authority to observe a nonterminal owned Pod assigned to a
   node before asserting `placed`. A replacement UID is refused.
2. `attest` records the exact owned Pod UID, Job UID and expected worker
   generation. Bootstrap cannot attest itself. `authorize-producer` binds a
   currently registered successor incarnation to the same receipt before it
   may issue launch operations under its recovery lease.
3. Bootstrap calls `POST /runs/activate` with the run token, receipt fence,
   Job UID, and `x-lcars-worker-identity` containing a **Pod-bound projected
   Kubernetes JWT**. The request body has no Pod UID field. The application
   verifies the signature, issuer, audience, namespace and service-account UID,
   derives the immutable Pod UID from the signed `kubernetes.io` claim, and
   matches the inventory attestation in one activation transaction.
4. Only one Pod/generation receives a provider-execution permit. Activation is
   idempotent for that exact active worker; another Pod is denied. Heartbeat,
   completion, brief and credential routes require the same bound identity and
   `x-lcars-worker-generation`. Heartbeat/completion recheck the permit inside
   their run/task write transaction, fencing concurrent retirement. Transferring
   a permit requires exact positive `worker-retired` evidence; expiry alone
   cannot transfer it, and a terminated Pod UID cannot become a new generation.

`AGENT_LCARS_CAPACITY_WORKER_IDENTITIES` is a deployment-owned JSON array of
`poolId`, HTTPS `issuer`, HTTPS `jwksUri`, `audience`, `namespace`, and
`serviceAccountUid`. Trust roots are never supplied by a worker. Generic
service-account tokens lacking a bound Pod UID are refused. The direct-runner
must honor the activation gate before provider invocation; possessing mounted
provider keys is not permission to bypass it.

## Physical retirement and storage debt

Record each launch/update/delete RPC with `operation` **before** issuing it.
Only a definitive outcome resolves its exact producer/operation identity.
Timeouts and canceled requests remain pending. Ordinary quiescence through
`stop-producer` is allowed only for that authenticated producer and only after
all its operation groups have definitive outcomes. A separate positive fencing
authority may close an exact incarnation with unresolved server-side writes;
that closes future producer authority without pretending accepted writes have
drained. All affected receipts retain the pending operation identities.

`retire` first creates a permanent retired-attempt record and blocks future
activation and launch recovery while retaining the slot/domain. The executor
must then install and read back the inert deterministic-name Kubernetes Job
barrier described in the reviewed design. This is a receipt/retired-run-marked
credentialless tombstone or an exact UID/resourceVersion CAS of a positively
terminal or original never-started suspended Job. All owned workers must be
positively ended. A deletion request, force-delete, absent Job, failed list,
heartbeat expiry or merely a label is not physical evidence.

`release` accepts that barrier only under the current receipt recovery nonce,
after every authorized producer is positively stopped/fenced, with exact
original Job UID evidence and no active worker permit. Unknown or stale
receipt/nonce/UID evidence refuses release. A successful transaction releases
the fixed slot/domain and moves `Run.queue.state` to `retired`, preserving its
claimant metadata. Historical retired claims no longer enter active admission
queries. The permanent retired record prevents late activation or reuse.

Unresolved writes return `retainBarrier: true` even after the slot is released
behind a proven inert barrier. Keep the tombstone indefinitely until
`resolve-retired-write` confirms each exact producer subject, incarnation and
operation has a definitive outcome under the exact retired nonce/barrier UID.
No age/TTL-based cleanup is authorized. Tombstone deletion itself remains an
executor/Homelab operation; this API reports whether pending writes still
require its retention, not authority to ignore other physical obligations.

## Reviewed import and drain

`configure` fixes the pool cluster/namespace and requires a monotonically
increasing policy version. It always starts with unknown inventory; submitting
`inventoryKnown: true` in configuration cannot skip import. Enforced policies
refuse the old legacy claim method for every overlapping provider pipeline,
including callers without the new pool grant. Legacy claim release cannot
requeue an occupied receipt.

Use action `import` with `dryRun: true`, the exact observed claim/Job/Pod/
producer/RPC inventory and a retained operator evidence identity. The response
returns missing legacy claims, proposed occupancy, the active revision and a
SHA-256 review digest without writing anything. Unknown/partial inventory
stays unknown. To apply the same reviewed proposal through the application,
send `dryRun: false` with that `reviewedDigest`. Configuration/claim changes
invalidate the digest. Imported attempts remain quarantined until exact
recovery/retirement evidence; a token hash never supplies an absent secret.

The application bounds active state to 16 declared pools, 128 configured
slots, a 900,000-byte active document, eight authorized producer groups per
receipt and 32 unresolved operations per group. Active run inventory reads
refuse above 1,000 records rather than presenting partial zero occupancy.
Permanent producer/replay/retired records are individually keyed history
documents. These bounds are protocol/storage bounds, not approval to request
matching job resources. Any job still must fit one eligible supported runner
after host/service reserves.

A lower policy limit leaves existing receipts intact and blocks new admission
until they drain below the new bound. Old policy versions are refused. Server
enforcement cannot be disabled while receipts or unresolved legacy claims occupy
the pool, or while inventory is unknown. Rollback keeps
one receipt-aware executor and server enforcement; reverting to local legacy
accounting requires a separately approved, positively fenced empty-pool
migration.

## Evidence and metrics

`GET /runs/capacity/metrics` requires a capacity recovery/operator principal and
returns Prometheus exposition. Declared pool/domain identities and closed
transition/refusal enums bound every label. Metrics include physical/free
slots, reviewed inventory, policy version, oldest quarantine age, domain
occupancy, active worker permits, and process-lifetime transition/refusal
counts. No run IDs, tokens, producer IDs or arbitrary errors become labels.
Failed reads fail the scrape; missing samples do not mean zero capacity.
Homelab owns collector identity, alert consumers and live monitoring setup.

`capacity-contract.spec.ts` runs the same observable races against MemoryStore
and a real Firestore emulator. `capacity-routes.test.ts` exercises the real
HTTP contract, distinct grants and signed Pod-bound JWT validation. These
protect admission, response-loss, physical occupancy, generation, retirement,
migration and policy-drain contracts. They do not replace receipt-aware Go
client/Kubernetes failure probes or approved staging failover qualification.

The release observation names the barrier’s exact run ID and receipt nonce as
well as its Job UID and resource version. A mismatched nonce or unproved worker
exit keeps capacity occupied. A receipt retains up to 32 positively retired
worker identities; a previously retired Pod UID cannot acquire a later generation.
