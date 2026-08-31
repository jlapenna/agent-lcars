# Persisted orchestrator migration (temporary phase 1)

This is the application-owned, one-shot preparation for removing persisted
orchestrator compatibility readers. It is served only by the deployed console
Work API and requires an authenticated principal with the dedicated
`work.migrate` scope; it is
not a Firestore CLI, does not accept a project/database/collection name, and
must not be run from a developer shell with production credentials.

The temporary routes are:

- `GET /api/work/v1/orchestrator-migration/{task|run|outbox}` inventories one
  page (1--200) ordered by the fixed collection document ID. The response has
  only a safe record selector, SHA-256 fingerprint, at most 16 fixed finding
  codes, plus explicit `findingCount`/`findingsTruncated`; it never copies
  payloads or arbitrary field names. When a malformed payload cannot supply a
  coherent logical selector, it instead carries one bounded opaque address for
  the exact already-inventoried document in that same fixed collection. The
  address is not a collection, query, or general Firestore read surface and
  must match the replacement's canonical document ID. The response's
  `consistency: "page-only"` explicitly says this is not a cross-page snapshot.
- `POST /api/work/v1/orchestrator-migration` previews an explicit manifest by
  default (`mode` omitted or `dry-run`). It returns a stable `manifestId`.
  Existing typed replacement entries remain supported. A temporary deletion
  entry is value-free: `{ "operation": "delete", "selector": ..., "expectedFingerprint": ... }`;
  it cannot carry a replacement, query, or payload. Its dry-run result includes only the supplied selector and a closed
  `ready`/`blocked` safety disposition with fixed reasons.
- The same `POST` applies at most 100 fixed task/run/outbox replacements or
  deletions only when `mode: "apply"`, the caller echoes that exact
  `reviewedManifestId`, and sends `confirmation: "apply-reviewed-manifest"`.
  The store transaction re-reads every record and compares its fingerprint
  before writing or deleting, so a concurrent change aborts the whole bounded
  manifest.

Inventory reports compatibility candidates (missing Work task payload,
missing `consecutiveLost`, historical `infra` events, and retired top-level
fields) as well as meaningful optional field absences in Task, Run, and Outbox
records. Optional findings are census evidence, not permission to invent
values. An operator must review each full replacement outside the inventory
response and submit the exact typed manifest. A deletion is permitted only for
a record with a compatibility finding, never an optional-only finding. The
application rechecks its safety predicates inside the apply transaction: a Run
is terminal, has no active (or malformed) existing parent Task, and has no
pending or leased Outbox dependency; a Task has no active run and no child Run;
and an Outbox entry is terminal (`done` or `failed`). Run dependency reads stop
at three and Task child-run reads at one; reaching either bound refuses the
deletion rather than broadening the operation.

Do not run an apply during phase 1. After deployment approval, perform two
complete, back-to-back inventory passes during a quiescent maintenance window;
only identical safe-selector/fingerprint sets may be recorded as a stable
census. A single paged pass must never be called exact, because ordinary
orchestrator writes may occur between pages. Then record the reviewed dry run,
bounded apply, and a second stable post-apply census on the issue. Only then
may a later PR remove both this temporary route/store surface and the persisted
compatibility readers. This document and the route are intentionally deletable
with that phase-2 PR.
