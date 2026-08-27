# Native work items: a GitHub-independent task system

- **Status:** Approved design, pre-implementation
- **Date:** 2026-08-23 (rewritten 2026-08-25 on the one-store model)
- **Scope:** Design for the whole program; implementation scope for
  sub-project 1 only (see [Sequencing](#sequencing)).

## Problem

GitHub is currently the fleet's only ingress, its only task store, and its
only execution queue. A task _is_ a GitHub issue (`libs/orchestrator`'s
`TaskId = {repo, issue}`), dispatch _is_ a label webhook, execution _is_ a
`workflow_dispatch` onto GitHub Actions, and the human-interaction surface
(parking, outcome comments, redispatch triggers) lives on issue threads.
That blocks two wanted capabilities:

1. **Agent-initiated work** — an agent (interactive session, fleet member,
   or service) asking LCARS to do work directly, with no human touching
   GitHub. This is the driving use case.
2. **Scheduled/recurring work** — cron-style self-originated tasks.

It also makes runner execution inseparable from GitHub Actions queues, which
the fleet wants as an eventual, swappable backend rather than a load-bearing
assumption.

## Why this shape

The first draft of this spec kept a new `WorkItem` store beside the
orchestrator's `Task` and synchronized the two. Review found that every
piece of machinery it grew — an `admit` outbox kind, an idempotency
reservation collection, a repair sweep, a "projection" rule for item
state, a `cancel-run` kind, a second run-facing API — was a patch for that
one split, and that its justification ("the orchestrator stays unchanged")
did not hold. This rewrite has **one store**: the orchestrator's `Task` is
the work item, item state is **derived** from its runs, and runs keep using
the control-plane surface they already have.

## Decisions

| Question                       | Decision                                                                                                                                                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First end-to-end consumer      | Agent-initiated work via API                                                                                                                                                                                                                                                      |
| Structure                      | One store. The orchestrator's `Task` carries an opaque `work` payload for native anchors; `libs/work` is schemas, a derived view, and route handlers                                                                                                                              |
| Item state                     | Derived from the task and its latest run, never stored — except `closedAt`, an orchestrator-owned Task field written by a `closeTask` decision                                                                                                                                    |
| Deliverable                    | `Run.result` (`ok`, `summary`, `ref`) — already the orchestrator's shape; `ref` is the PR URL. Typed multi-results are a deferred extension                                                                                                                                       |
| GitHub's role for native tasks | None required. Native-first: console + API are the interaction surface                                                                                                                                                                                                            |
| API                            | Resource-oriented REST (`items`) + `lcars work` CLI; runs report through the existing hosted completion route, generalized to the anchor union. There is no renew route today and v1 adds none: the 2 h lease is the run budget, as it is for label-driven work                   |
| API framework                  | **oRPC 2** (decided 2026-08-25; `2.0.0-beta.31` on the `beta` dist-tag today, stable 1.15.0), contract-first — the fleet-wide pick shared with sprinkles#4837. Contract in `libs/work`, `@orpc/next` handler in the console, typed client in `lcars`, OpenAPI as a build artifact |
| Console callers                | The same procedures exposed as Next server functions (`@orpc/next`'s `createServerFunctionable`) with the Auth.js session as the principal source — no second handler set for the UI                                                                                              |
| Create                         | `PUT /items/{ulid}` with a client-generated ULID: read the task first (exists → `200`), else one `requestRun` transaction that also creates the task with its `work` payload                                                                                                      |
| Auth                           | OAuth2 resource server with two additive scopes: `work.operator` (grant list) and `work.agent` (GitHub Actions OIDC). Standard library, issuers as configuration                                                                                                                  |
| v1 human issuer                | Google via per-user service-account impersonation (a Google _user_ credential cannot mint an audience-scoped ID token); LCARS-minted tokens with sub-project 4                                                                                                                    |
| Pipeline selection             | `spec.pipeline` required; the grant list says which pipelines each principal may request — not every agent may trigger Claude                                                                                                                                                     |
| Admission                      | One global live-run cap, sized to runner capacity; `429`                                                                                                                                                                                                                          |
| Spec delivery                  | One `work` JSON `workflow_dispatch` input (`{ id, spec }`) in v1 — the workflows already use 8 of GitHub's 10 inputs; the direct-runner backend fetches via API later                                                                                                             |
| Execution                      | `Executor` seam at the outbox; GitHub Actions is backend 1, a direct-runner queue is backend 2                                                                                                                                                                                    |
| Sessions                       | Derived: the telemetry session doc already points at `runId`. Resume + lifecycle-pinned persistence are sub-project 6                                                                                                                                                             |
| Protocol end state             | Agents become GitHub-issue agnostic and use only the run-facing routes; issue-side affordances become control-plane projections (sub-project 5)                                                                                                                                   |

## Architecture

```mermaid
flowchart LR
  subgraph Ingress
    API["PUT /items (v1)"]
    WH["label webhook (existing)"]
    CRON["cron (later)"]
  end
  subgraph Orchestrator["libs/orchestrator (one store)"]
    T["Task: anchor + work payload"]
    R["Run: lease, result"]
    OB["outbox: dispatch-run, report-outcome"]
    T --- R --- OB
  end
  subgraph Exec["Executor"]
    GHA["GitHubActionsExecutor (v1)"]
    Q["QueueExecutor (later)"]
  end
  API --> T
  WH --> T
  CRON -.-> T
  OB --> GHA
  OB -.-> Q
  GHA --> RUN["worker run"]
  RUN -->|"finalizer → completion (OIDC)"| R
  V["libs/work: derived item view"] --> T
  CON["console /work"] --> V
  CLI["lcars work"] --> API
```

Invariants:

- The orchestrator remains a per-task mutex with an audit trail. It stores
  the `work` payload the way it stores `params`: opaque, never interpreted.
- `libs/work` depends on `libs/orchestrator`, never the reverse, and holds
  no state of its own.
- A run reports through the hosted control-plane routes it already uses.
  If the direct-runner backend later needs more (spec fetch), that becomes
  a route; nothing in v1 is added to the worker surface that GitHub Actions
  alone would need.

## Data model

```mermaid
erDiagram
  GRANT ||--o{ TASK : "principal may create"
  TASK ||--o{ RUN : "at most one live"
  RUN ||--o{ OUTBOX_ENTRY : "dispatch-run, report-outcome"
  RUN ||--o{ SESSION_DOC : "session doc points at runId"

  GRANT {
    string principal "user:jlapenna, svc:lcars-admin"
    string[] pipelines "which pipelines may be requested"
  }
  TASK {
    string key "repo#issue or work:ulid"
    object task "anchor: {repo, issue} or {workId}"
    string activeRunId "the mutex"
    int runCount
    int consecutiveLost
    object work "native only: origin, spec, closedAt - opaque"
  }
  RUN {
    string runId "work:ulid/rN"
    enum state "pending | running | finished | canceled | lost"
    string pipeline
    string requestId "idempotency"
    string leaseExpiresAt
    object result "ok, summary, ref - the deliverable"
    object[] events "bounded audit trail"
  }
  OUTBOX_ENTRY {
    string entryId
    enum kind "dispatch-run | report-outcome"
    enum state "pending | leased | done"
  }
  SESSION_DOC {
    string sessionId
    string runId "pointer, not ownership"
    string transcriptGcsUri
  }
```

### `Task` (existing, anchor-aware)

`TaskId` becomes a union of two shapes: the existing `{ repo, issue }`,
kept byte-for-byte as persisted today, and `{ workId }`. The variants are
discriminated by which key is present — never by a new required field,
because `FirestoreStore` zod-parses every persisted document on read and a
required field would reject the whole existing dataset. `taskKey()` emits
`repo#issue` (unchanged) or `work:<ulid>`; `:` is outside the repo-name
charset, so keys cannot collide. Zero migration.

A native task additionally carries `work`, opaque to the orchestrator.
Concretely: `taskSchema` gains an optional `work` field (strict zod,
bounded) and `RequestRunInput` gains `work?`, used only when the request
creates the task — `params` stays a per-run string record and is not
where `work` goes:

- `origin` — `{ principal, channel: 'api' | 'cron' | 'console' }`. The
  principal is LCARS-native (`user:jlapenna`, `svc:lcars-admin`), never a
  raw issuer subject.
- `spec` — `{ title, description, pipeline, target: { repo } }`. All
  bounded strings, strict zod. `pipeline` is required; `target.repo` is
  required while GitHub Actions is the only backend (an item no backend can
  launch is rejected). No `mode` — a review is a task whose description
  says so.
- `closedAt?` — the one piece of stored item state, and it is
  **orchestrator-owned**: a new `closeTask` decision in `decide.ts` sets it
  transactionally, refusing if a run is live, and `requestRun` refuses a
  closed task (`task-closed`). `libs/work` never writes the task document
  directly, so cancel and redispatch cannot race into "canceled with a live
  run".

### `Run` (existing, unchanged shape)

One execution. `result = { ok, summary, ref }` is already the deliverable
record; for native work `ref` is the PR URL. `requestId` is the
idempotency key the orchestrator already honors.

### Derived item state

Nothing stores an item state. `libs/work` derives it from the task (for
`closedAt` and the retry budget) and its latest run, first match wins:

| Condition                                                       | State      |
| --------------------------------------------------------------- | ---------- |
| `closedAt` set, or latest run `canceled`                        | `canceled` |
| a run is live (`pending` / `running`)                           | `running`  |
| latest run `finished` with `ok: true`                           | `done`     |
| latest run `finished` with `ok: false`                          | `parked`   |
| latest run `lost` and `task.consecutiveLost > MAX_AUTO_RETRIES` | `parked`   |
| latest run `lost` otherwise (the sweep will mint the retry)     | `running`  |

```mermaid
stateDiagram-v2
  direction LR
  [*] --> running : PUT /items → requestRun mints r1
  running --> done : r_n finished ok
  running --> parked : r_n finished not ok, or lost ×3
  running --> canceled : cancel → cancelRun
  parked --> running : redispatch → requestRun mints r_n+1
  parked --> canceled : cancel → closedAt
  done --> [*]
  canceled --> [*]
```

A budget-exhausted run stays `lost` with no `result` — nothing rewrites it
to a failure — which is why the derivation reads the task's
`consecutiveLost` rather than looking for `ok: false`.

### Sessions

Telemetry already stores each agent session at `sessions/{sessionId}`
with a `runId` pointer — but that `runId` is the **GitHub Actions run id**
(`RUN_ID: ${{ github.run_id }}` in the lane), not the orchestrator's. v1
adds the orchestrator run ID to the session doc as `intentId`: the lane
already receives it as `broker_intent_id` and passes it to the telemetry
sidecar as one more env var. Item → runs → sessions is then a query on
`intentId`, not a link. The
relationships: Task 1→N Run (sequential, mutex-enforced); Run↔Session N:M
over time — a run has one primary session, an interactive takeover
continues a session past its run, and (sub-project 6) a later run may
resume an earlier one. Session **resume** and lifecycle-pinned
**persistence** are one feature and arrive together: `redispatch` gains
`resumeSessionId`, and a session pointing at any run of an open item is
exempt from `expireAt` reaping until the item settles.

### Collections and writers

| Collection             | Written by                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `tasks/{key}`          | Orchestrator transactions. `work.closedAt` is the one field `libs/work` writes, via the cancel route |
| `runs/{runId}`         | Orchestrator transactions (request, dispatch, renew, report, sweep)                                  |
| `outbox/{entryId}`     | Orchestrator decisions; the drain leases and settles                                                 |
| `sessions/{sessionId}` | Telemetry sidecar; untouched                                                                         |
| grants                 | Configuration                                                                                        |

## API

Resource-oriented REST under `apps/console/src/app/api/work/v1/`. The
Edge proxy (`apps/console/src/proxy.ts`) returns `401` for any `/api`
path not in its allow-list before any handler runs, so `/api/work/v1/`
goes into `publicPrefixes` (#1232 shipped a control-plane route without
its entry; #885 is the fix that made the gap observable). That hands the
whole catch-all tree to the handler's own auth, and the on-disk route scan
in `proxy.test.ts` sees one `route.ts` regardless of how many procedures
it serves — so the auth middleware is applied at the **router** level to
the `items` router, and a contract test walks every procedure in the
router asserting the auth middleware is present (v2 no longer
deduplicates middleware automatically, so a stray unguarded procedure is a
realistic mistake).

### Framework: oRPC 2, contract-first

The fleet's one API framework (decided with sprinkles#4837): **oRPC 2**.
Today that is `2.0.0-beta.31` on the `beta` dist-tag (stable is 1.15.0);
the fleet adopts the 2.x line deliberately rather than 1.x, because v2
changed the wire format — a v1 client cannot talk to a v2 server — and
starting on 1.x would mean a coordinated server-and-client migration
later. Renovate tracks the dependency to its stable release like any other
third-party package. Each repository adopts it independently; nothing is
shared as source.

What v2 means concretely (from the v1→v2 migration guide):

- **Packages:** `@orpc/contract`, `@orpc/server`, `@orpc/client`,
  `@orpc/openapi` (which absorbed `openapi-client`), `@orpc/next`
  (which absorbed `@orpc/react`), and `@orpc/zod` for JSON-schema
  conversion. **Zod v4 is required** — the console is on 4.4.3.
- **Routing is OpenAPI metadata:** `oc.meta(openapi({ method: 'PUT',
path: '/items/{id}' }))` on the contract; `.route`/`.prefix`/`.tag` no
  longer exist.
- **Contract** lives in `libs/work` beside the schemas, dependency-light
  and free of `server-only` imports so the CLI can import it (the same
  discipline `dispatch-contracts` follows for `'use client'` bundles).
- **Handler:** one catch-all route,
  `apps/console/src/app/api/work/v1/[[...rest]]/route.ts`, serving an
  `OpenAPIHandler` from `@orpc/openapi/fetch`. The per-request **context** is where
  auth lives: it accepts either a bearer token (Google service-account or
  GitHub Actions OIDC, verified as below) _or_ an Auth.js session
  (`auth()`), and maps both to one principal + scopes. Middleware is
  guarded with v2's context-flag pattern (automatic deduplication is
  gone), and HTTP statuses for errors are the handler's `errorStatusMap`.
- **Console pages** call the same procedures as **server functions** —
  `createServerFunctionable({ context })` from `@orpc/next` — with the
  session as principal, `user:<github-login>`, instead of a second
  handler set.
- **Clients:** `lcars work` uses the typed contract client
  (`@orpc/client` + `OpenAPILink` from `@orpc/openapi`); agents and
  scripts use the generated OpenAPI document with `curl`; a later MCP
  wrapper is generic tools over the same contract, as sprinkles plans.
- **Migration-off path**, since v2 is still beta: the contract is plain
  zod plus route metadata, so replacing the framework is mechanical.
  Existing hand-rolled control-plane routes are not migrated in v1.

### `items` — issuing and following work (`work.operator`)

| Route                        | Purpose                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /items/:id`             | Create. `:id` is a client-generated ULID; the body is `spec`. Read the task first: if `work:<id>` exists, `200` with the existing item and no `requestRun` — the orchestrator's `duplicate-request` only covers the window while r1 is live, so a replay after r1 settles must not mint r2. Else `requestRun({ workId }, pipeline, requestId: id, work)`, `201`. |
| `GET /items/:id`             | Derived state, spec, origin, runs (with results), and the sessions telemetry holds for those runs.                                                                                                                                                                                                                                                               |
| `GET /items`                 | List/filter by state, principal, target repo.                                                                                                                                                                                                                                                                                                                    |
| `POST /items/:id/cancel`     | Derived `done` or `canceled` → `409`. Live run → `cancelRun`. `parked` → `closeTask`.                                                                                                                                                                                                                                                                            |
| `POST /items/:id/redispatch` | `parked` only → `requestRun` with the same `work` and a fresh `requestId`; `409` otherwise. The reply-trigger analog.                                                                                                                                                                                                                                            |

Idempotent create is the standard client-ID PUT: because the ID is
client-generated, the only concurrent replayer is the same client, so
read-then-request is acceptable and `duplicate-request` covers the
in-flight window. The global live-run cap is likewise check-then-act;
it is advisory, bounded by request concurrency, and sized with slack. Admission is checked before `requestRun`: a
principal without a grant for `spec.pipeline` gets `403`; a fleet at the
global live-run cap gets `429` with `Retry-After`. Status is poll-only in
v1 (`lcars work status --watch` polls).

### Runs — the existing completion route, generalized (`work.agent`)

The one hosted route a run's workflow uses today is **completion**, and
only the isolated fallback-finalizer job may call it — `job_workflow_ref`
is pinned to `agent-fallback-finalize.yml`, and the agent job never posts
to it. That stays exactly so: the agent job's `id-token: write` must not
become a way for a dispatched (or prompt-injected) agent to certify its own
run as `ok` before `verify-deliverable` and the finalizer have run. The
finalizer posts `{ runId, ok, summary, ref }` from the agent job's outputs,
as it posts the outcome today.

| Route (existing) | Change for native anchors                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| completion       | Body always names the run by `runId`; `issue` stays for GitHub anchors. The run's `task` may be either anchor shape. `{ ok, summary, ref }` is the deliverable. |

There is no renew route and no worker calls one — `Orchestrator.renew`
exists but only tests invoke it. The 2 h `LEASE_MS` is therefore the run
budget for label-driven work today, and native work inherits the same
budget. A renew route (callable from the agent job, with its own
`job_workflow_ref` pin to `agent-lane.yml`) is added only when runs need
longer, not in v1.

The spec reaches the agent as one `work` JSON `workflow_dispatch` input,
`{ id, spec }`: the workflows already declare 8 of GitHub's 10 allowed
inputs, so two new ones would exhaust the limit. `spec.description` is
bounded to 16 KiB so the input fits the 65,535-character budget with
`reply`/`context` empty. Session status and progress use the channel that
already exists (`lcars session title` / status annotations); the item's
page shows them through the `intentId` join.

### One request, end to end

```mermaid
sequenceDiagram
  autonumber
  participant O as Operator (work.operator)
  participant API as Console API
  participant X as Orchestrator
  participant D as Outbox drain
  participant GH as GitHub Actions
  participant A as Agent job
  participant F as Finalizer job (work.agent)

  O->>API: PUT /items/01J... {spec}
  API->>API: grant for spec.pipeline? global cap? task already exists?
  API->>X: requestRun({workId}, pipeline, requestId, work)
  X-->>API: task + run r1 pending + dispatch-run entry (one txn)
  API-->>O: 201 {id, state: running}
  D->>GH: workflow_dispatch(work, marker)
  A->>A: work from the input, open PR with claim marker
  A-->>F: job outputs (ok, summary, PR URL)
  F->>API: completion {runId, ok, summary, ref} (finalizer OIDC)
  API->>GH: does the token's run carry the marker for r1?
  API->>X: report(r1) → finished, lock released
  O->>API: GET /items/01J... → done, runs[r1].result.ref
```

Step 3 is the only decision, and it is the transaction the orchestrator
already performs for label dispatch. Nothing is projected afterwards.

## Auth

The API is a plain OAuth2 resource server (RFC 6750 bearer tokens): verify
the JWT against the issuer's OIDC discovery + JWKS with `jose` (already
used by `github-actions-oidc.ts`, one cached JWKS per issuer), check
audience, apply the entry's claim predicates, map to a principal and
scopes. An Auth.js session is a third source for browser and server-action
callers, mapped to `user:<github-login>` with `work.operator`. Scopes are
additive; sources confine which scopes they may confer.

| Scope           | Confers                              | Issuer (v1)                             | Principal                |
| --------------- | ------------------------------------ | --------------------------------------- | ------------------------ |
| `work.operator` | The `items` routes, per grant list   | Google — service-account identity       | mapped from the SA email |
| `work.agent`    | The completion route for its own run | GitHub Actions OIDC, finalizer job only | `agent:run/<runId>`      |

- **Grant list.** Configuration: `{ principal → pipelines[] }`. A
  principal absent from it has no scope; one requesting a pipeline outside
  its list gets `403`. This is the whole authorization model — there is no
  admin scope in v1 because no admin-only route exists; the maintainer acts
  through the console's existing auth wall. An agent acting as the fleet's
  administrator is just a service-account principal with a broad grant.
- **Google, via impersonation.** A Google _user_ credential cannot mint an
  ID token for an LCARS-chosen audience (`gcloud auth print-identity-token
--audiences` refuses non-service accounts), and accepting Google's public
  client audiences would make every ID token the user mints for any other
  service a valid LCARS bearer. So each human impersonates a per-user
  service account (`--impersonate-service-account … --audiences <lcars>
--include-email`; one IAM Token Creator binding per user under the usual
  Terraform approval), and the `lcars` CLI hides it. Chosen because it is
  free today, not because it is contractual: moving to another IdP, or to
  LCARS-minted tokens (sub-project 4), is a configuration entry.
- **GitHub Actions, with predicates.** Signature, issuer, and audience are
  not sufficient — any repository can mint a token requesting our audience.
  The existing predicates apply unchanged: `repository` in the
  control-plane allow-list, `ref` is `refs/heads/main`, `event_name` is
  `workflow_dispatch`, `workflow_ref` claim-relative to the worker workflow
  files, and `job_workflow_ref` pinned to the fallback finalizer. Nothing
  in v1 accepts a token minted inside the agent job.
- **Binding a token to its run.** The predicates prove "a trusted worker on
  an allowed repository", not "the worker for _this_ run". The run routes
  therefore verify that the Actions run named by the token's own
  `(repository, run_id)` has a `display_title` dispatch marker whose
  `intentId` is the `runId` in the body — the deterministic join
  `orchestrator-terminal-runs.ts` already uses. One GitHub API call, no
  stored binding state. This replaces the completion route's current
  `run.task.issue === body.issue` tie, which cannot hold for a native
  anchor, and applies to both anchor kinds. It puts one GitHub API call on
  the settle path, so its failure mode is stated: **fail closed**. A GitHub
  error refuses the completion with `503`, the finalizer retries with
  backoff (a change to the finalizer, which posts once today), and the
  existing terminal-run probe — already GitHub-dependent, already run by
  every reconcile — settles a run whose job has ended in the meantime. An
  outage delays settlement; it never settles a run on an unverified token.
- **One human, one principal.** A grant entry carries the subjects that
  map to it — `{ principal: 'user:jlapenna', subjects: ['<sa email>',
'github:jlapenna'], pipelines: [...] }` — so the same person is the same
  principal whether they arrive by impersonated service account or by
  Auth.js session.

## Execution abstraction

The seam is the outbox: a `dispatch-run` entry is handed to an
**`Executor`** — `dispatch(run, task)` — selected per anchor. Cancel is
what it is today: `cancelRun` settles the run and the job's later calls are
refused; nothing reaches into Actions.

### Backend 1 (v1): `GitHubActionsExecutor`

Today's `workflow_dispatch` drain
(`apps/console/src/lib/orchestrator-dispatch.ts`) as the first
implementation. GitHub Actions remains the queue and credential broker in
v1 — deliberately, since the driver is agent-initiated _ingress_, not
runner independence. The repository comes from `anchorTarget(task)`: the
anchor's `repo` for GitHub, `work.spec.target.repo` for native. The same
helper replaces the other `task.repo` / `task.issue` reads
(`orchestrator-routes.ts`, `orchestrator-terminal-runs.ts`), and
`FirestoreStore.listRuns` gains an anchor-aware query — the store contract
spec covers both anchors and runs against the Firestore emulator in CI
(today its Firestore half is skipped there).

The worker workflows are issue-anchored at every layer — `issue` is a
required input, both jobs are gated on it, `run-name` embeds it, the lane
reads it in roughly ten steps, and the fallback finalizer pipes it through
`tonumber`. The native path:

- `issue` becomes optional; one `work` JSON input is the alternative
  anchor, and the job gates accept either.
- `run-name` and the dispatch marker use `work:<ulid>/r<n>`; the marker
  grammar (`libs/dispatch-contracts/src/marker.ts`) gains that form, pinned.
- Each issue-reading lane step gets a native branch: the prompt is built
  from the `work` input, the sidecar receives `broker_intent_id` as
  `INTENT_ID`, `verify-deliverable` checks for the PR with this run's
  claim marker (as today), and the finalizer posts completion by `runId`.
- `report-outcome` for a native anchor posts nothing to GitHub; the item's
  state is already derivable. (`ref` is dispatched as `main`; there is no
  `target.ref` in v1.)

### Backend 2 (later): `QueueExecutor`

The actual de-GitHub-ing, as its own sub-project. LCARS keeps a claimable
run queue (Firestore, the outbox's lease/fencing pattern); the
runner-autoscaler polls it and launches the same runner image in "direct"
mode, where a bootstrap claims a run, fetches the spec through a new route,
runs the agent CLI, and reports through the same run routes. Runner
identity becomes an LCARS-minted per-run token.

## Dispatched-agent protocol in native mode

`agent-protocol` is written against an issue. v1 adds a short **native
mode** section mapping each issue-side action; label-driven behavior is
untouched.

| Protocol section                 | Issue mode (today)                   | Native mode (v1)                                                                                        |
| -------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 1. Takeover comment              | Comment naming the resume command    | Nothing to post: the session doc names the session; the console renders the takeover affordance from it |
| 2. Eyes-reaction acknowledgement | 👀 on the issue                      | Implicit: dispatch confirmation moves r_n to `running`                                                  |
| 3. One edited progress comment   | Single comment, edited in place      | `lcars session title` / status — the existing channel                                                   |
| 4. Parking                       | `status:needs-human` label + comment | Completion with `ok: false` and the summary; the item reads `parked`                                    |
| 5. Deliverable rule              | PR carrying the attempt-claim marker | Same PR and marker; `ref` in the completion body                                                        |
| 6–12. Everything else            | unchanged                            | unchanged                                                                                               |

PRs from native tasks are authored by the same bot logins, so
`agent-automerge.yml` treats them identically; the PR body references
`Work: work:<ulid>` rather than `Fixes #N`.

**End state.** Native mode is transitional. Once sub-project 5 makes
label-driven work carry a `work` payload too, every issue-side affordance
becomes a control-plane projection written by the drain, and the
agent-facing contract is the run routes alone.

## Console

Two pages behind the existing auth wall: `/work` — the derived list, parked
first; `/work/[id]` — spec, runs with results, sessions, and the two
actions (cancel, redispatch).

## Error handling

Inherited: idempotent create; `duplicate-request` for in-flight replays;
outbox lease retry for dispatch failures; lease expiry → bounded auto-retry
→ `parked` by derivation. New surface follows house style: strict zod,
bounded strings, fail-closed validation. `403`/`429` are the only
synchronous refusals besides validation.

## Testing

- Store contract spec against memory and Firestore stores, the Firestore
  half now running against the emulator in CI; persisted-shape fixtures for
  the anchor union.
- Derived-state table-driven spec; route tests with stubbed tokens; claim
  predicate specs including per-job `job_workflow_ref` pins; proxy
  allow-list scan extended to `api/work/v1`.
- Workflow contract test for the optional `issue` / `work_id` gates; pinned
  marker grammar and `work:` key formats.
- The generated OpenAPI document checked in and diffed in CI, so a contract
  change is a visible review artifact.
- No real git in unit tests. Console E2E stays off while paused (#1049);
  the real-path proof is one native task dispatched end-to-end producing a
  PR on a test repo.

## Sequencing

1. **v1 (this spec):** adopt oRPC 2 (`beta` dist-tag); anchor union + `work` payload + `anchorTarget` +
   anchor-aware store; `items` routes, grant list, cap, OAuth2 gate with
   per-job pins and marker binding; generalized completion with marker binding and finalizer retry;
   `intentId` on session docs; native lane path; `lcars work`; two console pages; native-mode protocol
   section.
2. **Parked-work visibility + console polish** (see the section below; the
   Telegram paging originally listed here was dropped on 2026-08-27 — the
   console is the notification surface).
3. **Cron ingress:** a scheduler minting items from a schedule — see
   [Sub-project 3: cron ingress](#sub-project-3-cron-ingress).
4. **`QueueExecutor`:** direct runner mode + LCARS-minted run tokens +
   spec-fetch route — see
   [Sub-project 4: QueueExecutor](#sub-project-4-queueexecutor).
5. **Ingress unification:** label-driven work and Quick Tasks carry `work`;
   issue affordances become projections; the protocol collapses to the run
   routes.
6. **Session resume and persistence.**

## Deferred extensions

Added when something needs them; nothing above precludes them:

- Typed multi-results (`report`, `artifact`, `message`) beyond
  `Run.result`.
- Operator-attached links/evidence on an item.
- Per-principal caps, an admin scope, and `grants` as a resource (the
  trigger: an admin agent that must manage grants through the API).
- Streaming status; MCP transport; `target.ref`.

## Non-goals (v1)

- Migrating GitHub-anchored tasks or Quick Tasks.
- Targetless items; a review dispatch mode; a default pipeline.
- External notifications (Telegram or otherwise) for parked work: the
  console's own attention surfaces carry parked items (sub-project 2).
- Any change to the dispatched-agent protocol for label-driven work.
- Any issuer beyond Google (service-account identity) and GitHub Actions.

## Sub-project 2: parked-work visibility and console polish

Added 2026-08-27 after sub-project 1 shipped (#1527, #1531, #1532, #1534).
Maintainer ruling: no Telegram (or any external) paging — the console is the
place a maintainer already looks, so parked native work must be visible
there without navigating to `/work`. Everything below is console-only; no
new secrets, Terraform, or runtime env vars.

### Parked work on the Bridge

The Bridge (`/`) gains a **Parked work** panel above the agent activity
panel, rendered only when at least one native item derives `parked`. It
reads the same `listItems` server function the `/work` page uses (so it
inherits the `work.operator` grant check: a signed-in admin without a grant
sees no panel, not an error), filters `state === 'parked'`, and lists each
item as a row: title (linking to `/work/<id>`), target repo, the latest
run's `result.summary` (the outcome kind), how long it has been parked
(`updatedAt`), and the existing `WorkActions` (redispatch / cancel). Sorted
oldest-parked first. This is the "notification": a parked item is on the
first page the maintainer opens until it is redispatched or canceled.

### `/work` in the primary navigation

`work` becomes a `CONSOLE_DESTINATIONS` entry (`/work`, label **Work**,
accent `violet` — the one accent not yet used by a destination), between
Shuttlebay and Sessions. The tablet-width constraint that kept it out in
sub-project 1 (a 768 px viewport must not scroll horizontally on any page —
`apps/console-e2e/src/mobile-header-every-page.spec.ts`) is met by the
existing `.lcars-nav { flex-wrap: wrap }`; the E2E view list gains
`/work`. The page-shell `current` value `'work'` already exists.

### Creating items from the console

`/work` gains a create form (title, description, target repo defaulting to
the control-plane repository, pipeline select over `PIPELINES`). It calls a
new `createItem` server function wrapping `workRouter.create` — the same
handler the API uses, so grants, the live-run cap, and validation apply
unchanged; `origin.channel` is `console`. The client generates the ULID
(`libs/work/src/ulid.ts`, Crockford base32 over `crypto.getRandomValues`)
so a retry of the same submission is idempotent. On `201` the page navigates
to `/work/<id>`; `FORBIDDEN` and `TOO_MANY_REQUESTS` render inline as
"no grant for that pipeline/repo" and "live-run cap reached".

### Native runs on the existing surfaces (#1530)

Two places derive a run's anchor from `#<n>:` in the Actions display title
and get `undefined` for `native work: …` titles:

- **Attribution.** `ExecutionAttempt` already carries `intentId` from the
  dispatch marker. A `workIdFromIntentId(intentId)` helper
  (`work:<ulid>/r<n>` → `<ulid>`) lets the agent activity panel link a native
  attempt to `/work/<ulid>` instead of the bare Actions run URL; the
  attempt stays in the "unattributed" group of `deriveLogicalWork` (that
  grouping is by GitHub task and is out of scope), but it is no longer
  anonymous.
- **Cancel from the runs view.** `notifyReconcileForCancelledRun` resolves
  the anchor from the marker when the title has no issue number: the marker's
  `intentId` is the orchestrator run id, so `reflectCancelledRunInOrchestrator`
  takes `{ issue }` or `{ runId }` and cancels by run id directly, then sweeps.

### Testing

Unit: nav destination list + header current-marking; `ulid()` shape and
uniqueness; create form (submits `{ id, spec }`, renders the two refusal
messages); parked panel (hidden at zero, rows sorted oldest first, actions
wired); `workIdFromIntentId`; cancel path with a native display title
(orchestrator `cancel` called with the intentId, no issue lookup). E2E:
`/work` joins `mobile-header-every-page`. Real path: after rollout, one
native item is created and driven to `parked` (its description asks the
agent to `PARK`) and the Bridge is checked by the maintainer; `get` via
`work-create.yml` shows `parked`; `redispatch` is exercised from the panel.

## Sub-project 3: cron ingress

**Purpose.** Recurring native work: an operator declares a cron expression
and a spec once, and a scheduled tick mints a work item for each due slot.
No new store and no new dispatch mechanism — the tick reuses `items`'
create path exactly (grants, the live-run cap, idempotent minting) via a
`mintItem` primitive extracted from `items.create`'s body. Requires
sub-project 2 (console polish) merged, for `libs/work`'s `ulid()`.

### Resource: `schedules`

`/api/work/v1/schedules`, the same `work.operator` auth every `items`
route uses, with one exception:

| Route                          | Scope           | Purpose                                                                                                                           |
| ------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /schedules/{id}`          | `work.operator` | Create. `{id}` a client ULID; body `{ cron, spec, enabled? = true }`. 201-always, idempotent by id (same rule as `items.create`). |
| `GET /schedules/{id}`          | `work.operator` | Read one schedule.                                                                                                                |
| `GET /schedules`               | `work.operator` | List, newest first, `limit`.                                                                                                      |
| `POST /schedules/{id}/enable`  | `work.operator` | Re-enable a disabled schedule; clears `disabledReason`.                                                                           |
| `POST /schedules/{id}/disable` | `work.operator` | Disable; sets `disabledReason: 'operator'`.                                                                                       |
| `POST /schedules/tick`         | `work.cron`     | Mint items for every enabled schedule's latest due slot. Not an operator route — see Auth below.                                  |

### Schedule document

Strict zod, stored opaquely by a new `ScheduleStore` (`libs/orchestrator`)
exactly the way `Task.work` is opaque to the orchestrator itself — `spec`
is a bounded record at the store layer, validated as `workSpecSchema` by
`libs/work` on every read and write:

```
{ scheduleId: WORK_ID_RE, cron: string, spec: WorkSpec,
  enabled: boolean, createdBy: principal string,
  createdAt, updatedAt,
  lastSlotAt?: ISO, lastItemId?: WORK_ID_RE,
  disabledReason?: 'grant-revoked' | 'operator' }
```

`ScheduleStore`: `readSchedule`, `writeSchedule` (create-or-replace,
last-write-wins — a schedule is configuration plus a watermark, not a
mutex over live work like `Task`), `listSchedules(limit)`,
`listEnabledSchedules()`. Memory and Firestore implementations, collection
`${prefix}schedules` beside `${prefix}tasks`/`runs`/`outbox`, the
Firestore half run against the same CI emulator `items`' store contract
already uses.

### Cron grammar

5-field (`min hour dom mon dow`), UTC only, `*`, lists, ranges, `*/n`
steps, minute granularity — no third-party dependency
(`libs/work/src/cron.ts`; third-party deps are root-only and need
Renovate). All five fields are ANDed (deliberately not POSIX's
dom-OR-dow special case, where restricting both day-of-month and
day-of-week ORs them instead). `parseCron(expr)` throws on anything
malformed. `latestDueSlot(spec, now, after?)` returns the latest minute
boundary `<= now` that matches and is strictly after `after`, or
`undefined`. `nextDueSlot(spec, from, horizonDays = 366)` searches
forward instead, and is what schedule creation uses: a syntactically
valid expression that can never actually fire (e.g. `0 0 31 2 *`, since
no February has a 31st) is rejected at create time with `400`, rather
than sitting enabled and costing a full lookback walk on every tick
forever.

### Tick semantics

`work-schedules-tick.yml` calls `POST /schedules/tick` every 5 minutes
with an empty JSON body. Creation seeds `lastSlotAt` to the creation
instant, so a schedule's first slot is the first boundary after its
creation. For each enabled schedule:

1. `slot = latestDueSlot(cron, now, schedule.lastSlotAt)`. No slot → skip;
   `lastSlotAt` untouched.
2. `itemId = slotItemId(scheduleId, slot)`: the 10-char ULID time prefix
   of `slot.getTime()` plus 16 Crockford characters derived from
   `sha256(scheduleId + ':' + slot.toISOString())` (each of the digest's
   first 16 bytes mapped through `byte % 32`). Deterministic — a re-tick
   of the same slot (a retry, or two ticks racing before `lastSlotAt`
   advances) always names the same item, so minting goes through
   `mintItem`'s idempotent-create path rather than starting a second run.
   A missed slot is never backfilled: only the latest due slot is minted
   each tick, and an older one is silently superseded.
3. Grants are re-checked at mint time against the schedule's `createdBy`
   principal — never the tick caller's own `cron:tick` identity, which
   carries no grant of its own — using the same `forbiddenReason` rule
   `create` and `redispatch` already apply. A refusal disables the
   schedule (`disabledReason: 'grant-revoked'`) instead of retrying a
   refusal every 5 minutes forever.
4. The live-run cap applies. At the cap, this schedule is skipped for
   this tick and `lastSlotAt` does **not** advance — the same slot is
   retried on the next tick until it mints or a newer slot supersedes it
   (`latestDueSlot` always resolves to the _latest_ due slot, never a
   queue of missed ones).
5. On a mint (new or idempotently replayed), `lastSlotAt = slot` and
   `lastItemId = itemId`.

Origin on the minted item: `{ principal: 'cron:<scheduleId>', channel:
'cron' }` — the `'cron'` channel `workOriginSchema` already reserved.
Response: `{ ticked, minted: [{scheduleId, itemId}], skippedCap: [...],
disabled: [...] }`, `ticked` the count of enabled schedules considered.

`mintItem(context, { id, spec, origin, grantsPrincipal })` is extracted
from `items.create`'s body so both paths run the identical
existing-item / `CONFLICT` / cap / `request` / `drain` sequence; the only
difference between a client-driven create and a tick-driven mint is which
principal's grant is checked and where the id comes from.

### Auth for the tick

`POST /schedules/tick` has no human or service-account caller — only the
scheduled workflow. A new scope `work.cron` (beside `work.operator`) is
granted by GitHub Actions OIDC alone:
`assertScheduleTickOidcClaims`/`verifyScheduleTickOidcToken` in
`github-actions-oidc.ts` mirror the reconciler's pair — audience
`agent-lcars-work-schedules`, repository pinned to the control-plane home
(not the allow-list, like the reconciler), `ref: refs/heads/main`,
`event_name` in `{schedule, workflow_dispatch}`, `job_workflow_ref`
pinned to `.github/workflows/work-schedules-tick.yml@refs/heads/main`.
`authenticateWorkRequest` grows a third branch: a bearer that fails Google
verification is tried against this verifier before the request is
refused, producing `{ principal: 'cron:tick', via: 'oidc', scopes:
['work.cron'] }`. No grant-list entry for `cron:tick` itself — `work.cron`
confers nothing but tick access, and the tick re-checks every schedule's
own `createdBy` grant per schedule.

### Console

`/work/schedules` (session-gated like `/work`, `current: 'work'`): a table
(title, cron, pipeline, repo, enabled, last item linking to `/work/<id>`),
a create form (title, description, repo defaulting to the control-plane
repository, pipeline select, a cron field validated client-side with the
same `parseCron`), and enable/disable buttons as server functions — the
same `createServerFunctionable` pattern `/work`'s cancel/redispatch
already use. `/work`'s header links to it. No CLI changes in this
sub-project; the API and console suffice.

### Testing

Cron evaluator table tests (every operator, invalid expressions throw);
`slotItemId` determinism against `WORK_ID_RE`; `ScheduleStore` contract
against memory and the Firestore emulator; router tests for
create/get/list/enable/disable and for the tick (not due, due plus
idempotent re-tick, cap-skip leaving `lastSlotAt` untouched,
grant-revoked disabling); OIDC claim tests mirroring the reconciler's;
console page/form tests; a workflow text-assertion test for
`work-schedules-tick.yml`'s cadence, trigger, minimal permissions, and
target; the OpenAPI document regenerated and diffed in CI as it already
is for `items`. `/api/work/v1/` is already the whole prefix's proxy
allow-list entry (`proxy.ts`) — the tick route needs no proxy change.

```mermaid
sequenceDiagram
  autonumber
  participant S as work-schedules-tick.yml (schedule)
  participant API as Console API
  participant G as Grants
  participant X as Orchestrator
  participant D as Outbox drain

  S->>API: POST /schedules/tick (OIDC, work.cron)
  API->>API: for each enabled schedule, latestDueSlot(cron, now, lastSlotAt)
  API->>API: itemId = slotItemId(scheduleId, slot)
  API->>G: forbiddenReason(schedule.createdBy, spec)
  alt refused
    API->>API: disable schedule (grant-revoked)
  else at live-run cap
    API->>API: skip, leave lastSlotAt untouched
  else granted
    API->>X: mintItem calls requestRun (idempotent by itemId)
    X-->>API: task plus run r1 pending
    API->>D: drain dispatches to GitHub Actions
    API->>API: writeSchedule with lastSlotAt=slot lastItemId=itemId
  end
  API-->>S: ticked, minted, skippedCap, disabled
```

## Sub-project 4: QueueExecutor

**Purpose.** The actual de-GitHub-ing (#547's "Execution abstraction" §
`QueueExecutor`). A `github-actions`-executor run is unchanged end to end;
a `queue`-executor run is drained onto the run document itself instead of
into a `workflow_dispatch` call, a runner-autoscaler-launched container
claims it directly, and it reports through four new run routes instead of
the GitHub-OIDC-authenticated completion path. No new collection, no new
Terraform, no new secret: claiming reuses the outbox's lease/fencing
pattern on `Run` itself, and every new credential (the autoscaler's claim
identity, a run's checkout token) is minted from App/service-account
material already deployed for a different purpose. One pipeline —
`claude` — end to end; `codex`/`opencode` follow later (the `claude-code-
action` GitHub Action they run through in `github-actions` mode has no
direct-mode equivalent yet).

### The `executor` field

`Run` gains `executor: z.enum(['github-actions', 'queue']).optional()`
(absent means `'github-actions'`, so every existing persisted run parses
unchanged — zero migration, the same discipline `Task.consecutiveLost`
already established). `workSpecSchema` is **unchanged**: an item's spec
carries no executor opinion. Instead, console configuration
`AGENT_LCARS_QUEUE_PIPELINES` (a JSON array of pipeline names, default
`[]`) says which pipelines route to the queue; `RequestRunInput` (`libs/
orchestrator/src/decide.ts`) gains an optional `executor`, threaded from
`Orchestrator.request`'s `RequestInput` straight into the minted `Run` by
`mintRun`. `work-router.ts`'s `create` and `redispatch` handlers are the
only two callers that decide it, both the same way:

```ts
function executorFor(spec: WorkSpec, queuePipelines: readonly string[]) {
  return queuePipelines.includes(spec.pipeline) ? 'queue' : 'github-actions';
}
```

evaluated **at request time**, against the config as it stands _then_ —
identical in spirit to `forbiddenReason`'s existing "re-checked against
grants and the repository list as they stand now" rule for `redispatch`.
A GitHub-anchored task (`handleWebhookDelivery`, `handleDispatchRequest`)
never sets `executor`: those requests have no `WorkSpec.pipeline` to look
up in `AGENT_LCARS_QUEUE_PIPELINES` in the first place, and GitHub-
anchored tasks always run `github-actions` — the queue only ever serves
native work.

### Queue state machine

A `queue`-executor run's outbox `dispatch-run` entry is drained by writing
a claimable state directly onto the run document — `Run` gains an optional
`queue` field:

```ts
export const runQueueSchema = z.strictObject({
  state: z.enum(['queued', 'claimed']),
  claimedAt: isoUtc.optional(),
  claimedBy: z.string().min(1).max(256).optional(),
  tokenHash: z.string().length(64).optional(), // hex sha256
});
```

```mermaid
stateDiagram-v2
  direction LR
  [*] --> queued : drain writes run.queue (executor=queue), confirmDispatch -> run.state=running
  queued --> claimed : POST /runs/claim transaction (queue.state cas)
  claimed --> [*] : POST /runs/:id/complete -> orchestrator.report (run.state=finished/lost)
```

`run.state` itself follows exactly the path a GitHub-Actions run already
follows: `pending` → `running` the moment dispatch is confirmed, which for
`queue` executor means "successfully written to the claimable state," the
same way it means "the `workflow_dispatch` API call returned 204" for
`github-actions` — in both cases `running` means "handed to the execution
mechanism," never "an agent is actively working." `run.queue.state` is the
finer-grained fact private to the queue mechanism: `queued` until some
runner claims it, `claimed` from then on. There is no `queue.state`
transition back to `queued` — a claimed-but-abandoned run is caught by the
**existing** run lease (`Orchestrator.sweepExpired` → `lost` → bounded
auto-retry via `MAX_AUTO_RETRIES` → `parked`), exactly as an abandoned
GitHub Actions run is today. Nothing new for liveness.

`OrchestratorStore` (`libs/orchestrator/src/store.ts`) gains:

```ts
/** Writes `run.queue = { state: 'queued' }` on an executor:'queue' run
 *  whose dispatch-run entry the drain is handling. Idempotent: a run
 *  already `queued` or `claimed` is left untouched. */
enqueueRun(input: { runId: string; now: string }): Promise<void>;

/** Transactionally claims the oldest `queued` run whose `pipeline` is one
 *  of `pipelines`, setting `queue.state = 'claimed'`,
 *  `queue.claimedAt`/`claimedBy`, and `queue.tokenHash`. Returns
 *  `undefined` when nothing is queued for those pipelines -- the caller's
 *  204. The same lease/fencing discipline `claimPendingOutbox` uses,
 *  scoped to `Run` documents instead of `OutboxEntry` ones: one Firestore
 *  transaction reads the candidate set and writes the winning claim, so
 *  two concurrent claim calls can never both win the same run. */
claimQueuedRun(input: {
  pipelines: readonly string[];
  now: string;
  claimedBy: string;
  tokenHash: string;
}): Promise<Run | undefined>;

/** Every run in `queue.state === 'queued'`, oldest (`createdAt`) first,
 *  bounded by `limit` (default 200) -- the same bound
 *  `listNativeTasks` already applies, for the same reason: a caller must
 *  not be able to force a full collection scan. Console-facing (queue
 *  depth on an operator page); `claimQueuedRun` does its own query. */
listQueuedRuns(limit?: number): Promise<Run[]>;
```

`MemoryStore` implements the equivalent in-process; `FirestoreStore`
implements `claimQueuedRun` as a `runTransaction` reading `#runs.where
('queue.state', '==', 'queued').where('pipeline', '==', p)` per candidate
pipeline (single-field-equality-only, no composite index, mirroring
`listRuns`'s existing two-clause equality query), picking the
lexicographically-least `createdAt` across the union, and writing the
claim inside the same transaction.

### Run routes

New resource, `/api/work/v1/runs`, served by the **same** oRPC catch-all
handler `items` already uses (`apps/console/src/app/api/work/v1/
[[...rest]]/route.ts` — no proxy change: `/api/work/v1/` is already the
whole allow-listed prefix). A new `runsContract` sits beside
`itemsContract` in `libs/work/src/contract.ts`; a new `runsRouter`
(`apps/console/src/lib/runs-router.ts`) implements it.

| Route                              | Auth                  | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /runs/claim`                 | `work.executor` scope | Body `{ runner: string, pipelines: string[] }`. Claims the oldest `queued` run for one of `pipelines`, renews its lease, mints and returns a run token. `204` when nothing is queued. Response `{ runId, workId, pipeline, token, expiresAt }`.                                                                                                                                                                                                                                        |
| `GET /runs/{runId}/brief`          | run-token bearer      | `{ id, spec, anchor, attemptId: 'g<generation>:<runId>', generation, intentId: runId }` — `id`/`spec` are exactly `prepare.sh`'s `WORK` input shape; `anchor` is what `prepare.sh` itself builds from `WORK` for a native run (title/body/target_repo/html_url); `attemptId`/`generation`/`intentId` substitute for the `broker_intent_id`/`broker_generation` `workflow_dispatch` inputs a GitHub-Actions run gets for free.                                                          |
| `POST /runs/{runId}/heartbeat`     | run-token bearer      | Renews the run's lease (`Orchestrator.renew`) — the same lease `github-actions` runs get from `confirmDispatch`/the (unused-by-workers) renew path; a direct runner is the first caller that actually needs it, since nothing external re-confirms it mid-flight.                                                                                                                                                                                                                      |
| `POST /runs/{runId}/complete`      | run-token bearer      | Body `{ outcome: unknown, outcomeReference: unknown }` — deliberately **not** `hostedCompletionRequestSchema` (that schema's `workflow`/`generation`/`issue`/`token` fields are GitHub-Actions-ledger concepts with no queue-executor analog); mapped through the **same** `toRunResult` helper `handleCompletion` uses. Binds by `runId` in the URL plus the bearer's `tokenHash` match — no marker binding, no OIDC.                                                                 |
| `GET /runs/{runId}/checkout-token` | run-token bearer      | Mints a short-lived GitHub App installation token scoped to `spec.target.repo`, via the **same** `AGENT_LCARS_APP_CLIENT_ID`/`AGENT_LCARS_APP_PRIVATE_KEY` credentials `createDispatchTokenProvider` already uses, with a broader permission set (`contents: write`, `pull-requests: write`, `issues: write` — the direct runner both checks out and pushes with this token, since there is no separate `claude[bot]`-vending Action in direct mode). Response `{ token, expiresAt }`. |

All four run-token routes share one gate, implemented in the handler (not
router middleware — the token check needs the `runId` path parameter,
which is only available after input validation, unlike the `operator`
gate's principal-only check): read the run, verify `run.queue?.tokenHash`
equals `sha256(bearer)` in constant time, and that `now <= run.
leaseExpiresAt` — an expired lease answers 401 even before the run settles
`lost`, so "expired token" is a synchronous fact, not something that waits
for the next reconcile sweep.

`claim` is gated the ordinary way: a `WorkPrincipal` with the new
`work.executor` scope, checked by a router-level `.use` middleware exactly
like `operator`'s.

### Token model

256-bit random (`crypto.randomBytes(32)`, base64url — `apps/console/src/
lib/run-token.ts`, mirroring `control-plane-request.ts`'s existing
`crypto.randomBytes(24).toString('base64url')` dispatch-token pattern),
returned **once**, on claim. Only `sha256(token)` (hex) is ever persisted,
on `run.queue.tokenHash`; every run-token route hashes the bearer and
compares against it with `crypto.timingSafeEqual`. No signing secret, no
JWT, no new Secret Manager entry — a stolen `tokenHash` is useless without
the token, and a stolen token is scoped to exactly one run and dies with
its lease. Invalidation on completion/cancel is **emergent**, not a
separate mechanism: `orchestrator.report`/`orchestrator.cancel` settle the
run out of `isLive`, and every run-token route's own liveness check
already refuses a non-live run (`run-not-live`) — there is nothing extra
to clear.

### Claim authentication: what the autoscaler actually is

The design brief for this sub-project assumed the runner-autoscaler is a
Cloud Run/GCE-hosted service that can mint a metadata-server ID token.
**That is not what it is.** `apps/runner-autoscaler` is a homelab Go
daemon (`orchestrator.go`) that supervises Docker containers over SSH/
local sockets across `pike`/`laforge`/`janeway`/`spark`
(`apps/runner-autoscaler/README.md`, `hosts.go`) — there is no GCE/Cloud
Run metadata server anywhere in its runtime. Its only existing GCP
identity is the `telemetry_writer` service account
(`infra/terraform/main.tf`), used **today**, optionally, to publish queue-
depth status to Firestore (`console_status.go`) — authenticated by a
downloaded JSON key (`google_secret_manager_secret.telemetry_writer_key`)
synced into the homelab's encrypted secret store and mounted as
`GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/telemetry-writer.json`.

A service-account JSON key can self-mint a Google ID token for **any**
audience directly from its own private key (a JWT-bearer token-endpoint
exchange — no metadata server, no extra IAM grant beyond holding the key
itself; Go's `google.golang.org/api/idtoken` package does this via
`idtoken.NewTokenSource(ctx, audience, idtoken.WithCredentialsFile(path))`,
and `google.golang.org/api` is already a transitive dependency of this
module's `cloud.google.com/go/firestore` import). So the claim identity
is: the **existing** `telemetry_writer` key, minting an ID token for
audience `agent-lcars-work` (the same audience `AGENT_LCARS_WORK_AUDIENCE`
already verifies for human/service-account operators), and a new
`AGENT_LCARS_WORK_GRANTS` entry naming that SA's email as a subject with
`scopes: ['work.executor']` (`WorkGrant.scopes` — see below). **No new
Terraform, no new IAM binding, no new secret** — this reuses a credential
and a role the fleet already granted for an unrelated purpose, which is
exactly the kind of coupling worth flagging rather than hiding: telemetry-
writer becomes, incidentally, also the claim identity. Acceptable because
it is read-scoped from the API's point of view (`work.executor` confers
only `POST /runs/claim`) and because minting a self-audience ID token
needs no permission beyond possessing the key.

`grantSchema` (`work-grants.ts`) gains an optional `scopes` field:

```ts
const grantSchema = z.strictObject({
  principal: z.string().min(1).max(128),
  subjects: z.array(z.string().min(1).max(256)).min(1),
  pipelines: z.array(z.string().min(1).max(64)).min(1),
  scopes: z.array(z.enum(['work.operator', 'work.executor'])).optional(),
});
```

absent means `['work.operator']` — every existing grant entry keeps its
current meaning unchanged. `WorkScope` (`work-auth.ts`) gains
`'work.executor'`; `principalFor` maps `grant.scopes ?? ['work.operator']`
onto `WorkPrincipal.scopes` instead of the hard-coded `Set(['work.
operator'])` it builds today.

### Direct runner mode

The runner image (`apps/runner-autoscaler/runner-image/`) gains a second
entrypoint mode. `entrypoint.sh` branches on `RUNNER_MODE`:

```bash
if [ "${RUNNER_MODE:-}" = "direct" ]; then
  exec /usr/local/lib/agent-lcars/direct-runner.sh
fi
exec /home/runner/run.sh "$@"
```

`bin/direct-runner.sh` (new, baked into the image the same way `sidecar-
lifecycle.sh`/`lcars.sh` already are) reproduces the `claude`-pipeline
slice of `agent-lane.yml`, sourced from `LCARS_RUN_ID`/`LCARS_RUN_TOKEN`
(env, set by the autoscaler at container launch — decision: the
autoscaler claims, then hands the claim to the container by env, rather
than the container claiming for itself, so a failed launch never strands
a claimed-but-never-started run beyond the ordinary lease backstop):

```mermaid
sequenceDiagram
  autonumber
  participant AS as runner-autoscaler
  participant API as Console API (runs)
  participant C as Direct-runner container
  participant CL as claude CLI
  participant GH as GitHub

  AS->>API: POST /runs/claim {runner, pipelines:["claude"]} (Google ID token, work.executor)
  API-->>AS: {runId, workId, pipeline, token, expiresAt} or 204
  AS->>C: docker run RUNNER_MODE=direct LCARS_RUN_ID LCARS_RUN_TOKEN (image FileMount: telemetry-writer.json)
  C->>API: GET /runs/:id/brief (run token)
  API-->>C: {id, spec, anchor, attemptId, generation, intentId}
  C->>API: GET /runs/:id/checkout-token (run token)
  API-->>C: {token, expiresAt}
  C->>GH: git checkout spec.target.repo (checkout token)
  C->>C: prepare.sh WORK=... -> context.json, install-skills.sh (unmodified)
  C->>C: start telemetry sidecar (--intent-id, WRITER_CREDENTIALS_FILE=mounted key)
  C->>CL: claude headless run with the lane's resolved prompt + attempt-claim marker
  CL->>GH: push branch, open PR (checkout token as push credential)
  C->>C: verify-deliverable.sh NUM='' ATTEMPT_ID=...
  C->>API: POST /runs/:id/complete {outcome, outcomeReference} (run token)
  API-->>C: {runId, state: finished}
```

Concretely, `direct-runner.sh`:

1. Fetches the brief, builds `WORK="$(jq -c '{id,spec}' <<<"$brief")"`.
2. Fetches a checkout token; `git clone`/checkout `spec.target.repo` with
   it persisted as the git credential (the same `http.extraheader` shape
   `actions/checkout persist-credentials: true` leaves behind), and
   exports it as `GH_TOKEN` for the deliverable gate's `gh` calls.
3. `export GITHUB_REPOSITORY="$(jq -r '.spec.target.repo' <<<"$brief")"`
   — the sidecar's `--repo` flag falls back to this env var
   (`runner-config.ts`'s `loadRunnerConfig`), so `sidecar-lifecycle.sh`
   needs no new flag.
4. Runs `prepare.sh` unmodified (`GITHUB_ACTION_PATH`/`GITHUB_WORKSPACE`/
   `GITHUB_OUTPUT`/`GITHUB_ENV` pointed at scratch files/dirs it creates;
   `WORK`, `MODE=implement`, `REPLY=''`, `RUNBOOK=''`, `CONTEXT=''`,
   budget minutes) to produce `$RUNNER_TEMP/agent-dispatch/context.json`
   and install skills — both already anchor-agnostic.
5. Builds `AGENT_PROMPT` by the **same template** `agent-lane.yml`'s
   "Resolve the canonical dispatch prompt" step inlines (copied, since
   that step is workflow YAML, not an extractable script — a duplication
   this plan's self-review flags as a drift risk, not fixed here).
6. Starts the telemetry sidecar (`sidecar-lifecycle.sh start`,
   `WRITER_CREDENTIALS_FILE` pointed at a bind-mounted copy of the
   _same_ `telemetry-writer.json` the autoscaler itself already mounts —
   delivered into the container the way `Config.FileMounts` already
   delivers host secret files into any runner container, homelab#101 —
   `RUN_ID="$LCARS_RUN_ID"`, `INTENT_ID` from the brief).
7. Runs `claude` headless (`claude --print ...`) with the resolved
   prompt. **Flagged guess:** the exact non-interactive flag set that
   reproduces `anthropics/claude-code-action`'s internal invocation
   (`max_turns`, `allowed_bots`, `additional_permissions`) was not
   verified against the CLI's own reference during this design pass; the
   plan's task for this step names the gap explicitly.
8. `verify-deliverable.sh` (`GH_TOKEN`=checkout token, `NUM=''`,
   `MODE=implement`, `ATTEMPT_ID`) — unmodified, already anchor-agnostic.
9. On a pass, re-derives `{outcome: 'pull-request', outcomeReference:
{kind: 'pull-request', number}}` with the identical bot-authored-PR-
   carrying-the-marker `gh api` search `verify-deliverable.sh` already
   runs internally (that script deliberately emits no structured output
   — `agent-fallback-finalize.yml` re-derives evidence the same way for
   GitHub-Actions runs, and direct mode is its own finalizer, so it does
   the same). On a failure, posts `{outcome: 'no-deliverable'}` (outside
   `OK_OUTCOMES`, so `toRunResult` reports `ok: false`).
10. `POST /runs/:id/complete`.

Only `claude` ships in this sub-project. `codex`/`opencode` route through
`anthropics/claude-code-action`-shaped or CLI-native wrappers that were
not audited here; extending direct mode to them is follow-up work.

### Autoscaler change

`runOrchestrator` (`orchestrator.go`) starts one more goroutine, gated on
`LCARS_QUEUE_POLL=1`, alongside the existing `RunHostSampler`/orphan-
sweeper goroutines: a new `apps/runner-autoscaler/queue_executor.go`
polls `POST /runs/claim` on a fixed interval (`LCARS_QUEUE_POLL_INTERVAL`,
default 15s) for the pipelines named by `LCARS_QUEUE_PIPELINES` (comma-
separated; independently configured from the console's
`AGENT_LCARS_QUEUE_PIPELINES` — operationally they should agree, but
nothing enforces it, the same way no code enforces that a GitHub scale
set's `Labels` matches what a workflow actually requests). On a
successful claim it launches the direct-runner image as a plain, one-shot
Docker container (`newDockerClient`/`hosts.go` for host connectivity,
reused as-is) on a host from the existing pool — **not** wired through
`Scaler.HandleDesiredRunnerCount`/the GitHub scale-set state machine,
which is inherently about persistent, GitHub-registered, multi-job
runners; a direct-mode container is ephemeral and one-shot by design, so
a simpler dedicated launch path is the closest fit, not a corner cut.
Host placement is round-robin over the configured Docker hosts in this
first cut — the load-aware `pickHost` scoring `Scaler` uses for GitHub
scale sets is not reused here; a follow-up can adopt it once the queue
path has real traffic to justify the complexity. With `LCARS_QUEUE_POLL`
unset, this goroutine never starts and nothing else in the binary
changes — the GitHub scale-set path is untouched line for line.

### Feature flags

- **Console:** `AGENT_LCARS_QUEUE_PIPELINES` (JSON array, default `[]`).
  Empty means every request routes `github-actions` exactly as today —
  `executorFor` never returns `'queue'` for an empty list.
- **Autoscaler:** `LCARS_QUEUE_POLL=1` (default unset/`0`) plus
  `LCARS_QUEUE_PIPELINES` (comma-separated). Unset means the new
  goroutine never starts.
- Both must be set for the path to do anything; either alone is inert —
  the console would mint `queue`-executor runs nobody ever claims (caught
  by the ordinary lease/auto-retry/park backstop, same as any other
  undispatchable run) or the autoscaler would poll and find nothing
  (`204` every time).

### What stays unchanged

`github-actions`-executor runs: the whole `GithubActionsExecutor` drain
path, `confirmDispatch`, the hosted `/api/control-plane/completion` OIDC +
marker-binding route, the fallback finalizer, `agent-lane.yml`,
`work-auth.ts`'s Google/session principal paths, every existing grant
entry's meaning, the console `/work` pages' existing behavior beyond the
new column below, and `codex`/`opencode` end to end.

### Console

`/work/[id]`'s runs table gains an **Executor** column (`run.executor ??
'github-actions'`) and, for a `queue`-executor run with `run.queue`
present, a "claimed by `<claimedBy>`" line under its row when `queue.state
=== 'claimed'`. `ItemRunView` (`libs/work/src/derive.ts`) and
`itemRunViewSchema` (`contract.ts`) both gain `executor` and an optional
`queue: { state, claimedBy? }` projection (not `tokenHash` — that never
leaves the store). Nothing else on `/work` changes.

### Testing

- Store contract (`store-contract.ts`, run against `MemoryStore` and the
  Firestore emulator): `enqueueRun` idempotent on a re-drain,
  `claimQueuedRun` picks oldest-first, a claimed run is invisible to a
  second concurrent claim (transactional), `listQueuedRuns` ordering and
  `limit`.
- `orchestrator-dispatch.ts` drain test: an `executor: 'queue'` run's
  `dispatch-run` entry calls `store.enqueueRun` and `orchestrator.
confirmDispatch`, and calls **no** `fetch` (the injected `fetchImpl`
  stub asserts zero calls) — the negative case decision #8 exists to
  prove.
- `runs-router.test.ts` (mirroring `work-router.test.ts`'s harness):
  claim (found/none/wrong-scope), brief/heartbeat/complete/checkout-token
  each with a valid token, a wrong token (403), an expired-lease token
  (401), and a double-complete (second call refused `run-not-live`); a
  double-claim race resolved by the store contract test above, not
  re-proven here.
- `direct-runner.sh` bash test (`direct-runner.test.sh`, modeled on
  `prepare.test.sh`): fake `curl` (serves canned brief/checkout-token/
  complete responses) and a fake `claude` binary that writes a marked PR
  stub via a faked `gh`, asserting the script's `POST .../complete` body
  and that `verify-deliverable.sh` gates it.
- OpenAPI document regenerated and diffed in CI, extended for `runs`.
- Autoscaler: Go unit tests for the poll loop (claim → launch, `204` →
  no launch, `LCARS_QUEUE_POLL` unset → goroutine never starts) using a
  fake `POST /runs/claim` HTTP server and the existing `fakedocker_test.go`
  double.

### Real-path proof (last task, maintainer-gated)

Everything above works in `github-actions` mode with **zero** Terraform,
IAM, or new secrets. One thing does not: the direct runner needs
`CLAUDE_CODE_OAUTH_TOKEN` (today reachable only via GitHub-Actions-WIF
impersonation of `claude-token-reader@agent-lcars.iam.gserviceaccount.com`,
which a homelab Docker container cannot do) delivered some other way. The
closest option that adds no Terraform/IAM is the same pattern this design
already leans on twice: a maintainer places a copy of that secret's value
into the homelab encrypted secret store (`secrets-cli` skill) and adds a
`file_mount`/`queue_executor` config entry exposing it read-only into
direct-mode containers, exactly like `telemetry-writer.json`. This is a
**one-time manual credential-placement action, not a code change**, and
it is the one step in this whole sub-project that needs a human: every
task up to it lands and is verifiable with `AGENT_LCARS_QUEUE_PIPELINES`
at its default `[]`.

With that placement done: set `AGENT_LCARS_QUEUE_PIPELINES='["claude"]'`
on the console, `LCARS_QUEUE_POLL=1` plus `LCARS_QUEUE_PIPELINES=claude`
on the autoscaler's deploy (its config/env, homelab-side — deploy path
not owned by this repo), create one item via `work-create.yml`, watch the
autoscaler's logs claim it and the direct runner produce a PR, `get` →
`done`. Append a "Sub-project 4" section to `docs/native-work-smoke-
runbook.md` with the run id, container/host, and PR URL. Then set
`AGENT_LCARS_QUEUE_PIPELINES` back to `[]` so production stays on
`github-actions` until a maintainer deliberately opts a pipeline in.
