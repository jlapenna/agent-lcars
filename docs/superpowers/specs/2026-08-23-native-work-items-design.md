# Native work items: a GitHub-independent task system

- **Status:** Approved design, pre-implementation
- **Date:** 2026-08-23
- **Scope:** Design for the whole program; implementation scope for
  sub-project 1 only (see [Sequencing](#sequencing)).

## Problem

GitHub is currently the fleet's only ingress, its only task store, and its
only execution queue. A task _is_ a GitHub issue (`libs/orchestrator`'s
`TaskId = {repo, issue}`), dispatch _is_ a label webhook, execution _is_ a
`workflow_dispatch` onto GitHub Actions, and the human-interaction surface
(parking, outcome comments, redispatch triggers) lives entirely on issue
threads. That blocks two wanted capabilities:

1. **Agent-initiated work** — an agent (interactive session, fleet member,
   or service) asking LCARS to do work directly, with no human touching
   GitHub. This is the driving use case.
2. **Scheduled/recurring work** — cron-style self-originated tasks.

It also makes runner execution inseparable from GitHub Actions queues, which
the fleet wants as an eventual, swappable backend rather than a load-bearing
assumption.

## Decisions already made

Recorded from the brainstorming session that produced this spec:

| Question                       | Decision                                                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First end-to-end consumer      | Agent-initiated work via API                                                                                                                                                       |
| Deliverable model              | Generic typed results; only the PR result path wired in v1                                                                                                                         |
| GitHub's role for native tasks | None required. Native-first: console + API are the interaction surface; GitHub issues/PRs are optional typed _links_ (references/evidence)                                         |
| API transport                  | Versioned REST on the console + `lcars work` CLI subcommands; MCP can wrap later                                                                                                   |
| Auth                           | Standard OAuth 2.0 resource server; trusted OIDC issuers as configuration; no Google dependency in the contract                                                                    |
| Structure                      | New `libs/work` layer above the orchestrator (approach B); the orchestrator keeps its admission-mutex job unchanged                                                                |
| Naming                         | `WorkItem` / `libs/work` / `lcars work` — deliberately not "task", which the orchestrator already uses for its anchor                                                              |
| Pipeline selection             | `spec.pipeline` is required; no default. Triggering a pipeline is a per-principal grant, so not every agent can invoke every pipeline                                              |
| Admission                      | Per-principal live-run cap plus a global cap, both configuration; exceeding either is `429`                                                                                        |
| Modes                          | None on a WorkItem. A review is a specialized task (description + `github-pr` link), not a dispatch mode                                                                           |
| v1 human issuer                | Google ID tokens to start (ratified 2026-08-24); LCARS-minted tokens arrive with sub-project 4                                                                                     |
| Run binding                    | First trusted call binds the token's `(repository_id, run_id)` to the run; the existing completion route adopts the same rule in v1                                                |
| API shape                      | Resource-oriented (`items`, `runs`; `grants`/`caps` later) with additive OAuth2 scopes `work.agent` / `work.operator` / `work.admin`; issuers confine which scopes they may confer |
| Ownership                      | `cancel`/`redispatch` are the requester's or an admin's; reads are open to any granted principal; the `runs` routes belongs to the bound run alone                                 |
| Creation                       | One Firestore transaction (idempotency reservation + WorkItem + `admit` outbox entry); `requestRun` is the drained side effect                                                     |
| Status and targets             | Poll-only status in v1; items without `target.repo` are rejected while GitHub Actions is the only backend                                                                          |
| Protocol end state             | Native mode is transitional. Agents become GitHub-issue agnostic and use only the `runs` routes; issue-side affordances become control-plane projections (sub-project 5)           |

## Architecture

```
ingress adapters                 libs/work                 execution backends
----------------                 ---------                 ------------------
REST API (v1)      ─┐                                   ┌─ GitHubActionsExecutor (v1)
webhook (later)    ─┼─▶ createWorkItem() ─▶ WorkItem ─▶ Executor
cron (later)       ─┤          │              │         └─ QueueExecutor (later)
console (later)    ─┘          ▼              ▼
                        libs/orchestrator (unchanged job:
                        per-task mutex, leases, bounded
                        retry, transactional outbox)
```

Invariants:

- Ingress adapters converge on one internal `createWorkItem()`; nothing else
  writes WorkItems.
- `libs/work` is the only caller of the orchestrator's `requestRun` for
  native tasks, so admission rules stay in one place.
- `libs/work` depends on `libs/orchestrator`, never the reverse. The
  orchestrator continues to treat work as opaque.
- A run talks to the control plane **only** through the run-lifecycle API
  (fetch spec, renew lease, attach links, report results, report
  completion), starting in v1. If the v1 workflow needs something, it gets
  an API route, not a workflow input. This discipline is what makes the
  later non-GitHub execution backend a drop-in.

## Data model

Two layers, each keeping one job.

### `WorkItem` (new, `libs/work`, Firestore collection `workItems`)

The first-class task and source of truth.

- `id` — native ULID. Sortable, no GitHub semantics.
- `origin` — who asked and how:
  `{ principal, channel: 'api' | 'webhook' | 'cron' | 'console', requestId }`.
  `requestId` is the idempotency key: replays return the existing item.
- `spec` — what is wanted:
  `{ title, description, pipeline, target?: { repo, ref? } }`. `pipeline`
  is required — there is no default, because invoking a pipeline is a
  granted capability (see
  [Authorization and admission](#authorization-and-admission)). There is
  no `mode`: a review is a specialized task whose description says so and
  whose PR is a `github-pr` link, not a separate dispatch mode. The
  orchestrator's `params.mode` continues to exist for label-driven work
  only.
  `target` is schema-optional — that is the GitHub-optional part — but v1
  rejects its absence at the API (see Backend 1).
- `state` — `ready | running | parked | done | canceled`. Work lifecycle,
  distinct from the orchestrator's run lifecycle. `parked` is the native
  home of what `status:needs-human` means today.
- `links[]` — typed references (the "evidence" concept):
  `{ kind: 'github-issue' | 'github-pr' | 'session' | 'artifact' | 'url',
ref, note?, addedBy, at }`. A GitHub issue is just one of these.
- `results[]` — typed outcomes; see
  [Deliverables](#deliverables-results-and-evidence).
- `schedule?` — reserved for the cron sub-project. Unset and unread in v1.
- `events[]` — bounded audit trail, same pattern as `Run.events`.

All schemas are strict zod objects with bounded strings, matching house
style in `libs/orchestrator/src/model.ts`.

### Orchestrator (existing, minimally generalized)

Keeps exactly its current job: admission mutex, leases, bounded auto-retry,
transactional outbox. One change: `TaskId` becomes a union of two anchor
shapes — the existing `{ repo, issue }` object, kept byte-for-byte as it is
persisted today, and a new `{ workId }` object — with `taskKey()` emitting
the existing `repo#issue` string for GitHub anchors and `work:<ulid>` for
native ones. The variants are discriminated by which key is present, not by
a new `kind` field: `FirestoreStore` zod-parses every persisted Task, Run,
and OutboxEntry on read (`firestore-store.ts`), and each of those embeds a
`task: { repo, issue }` written under the current strict schema, so any
variant that _requires_ a field legacy documents lack would reject the
whole existing dataset at read time. A pinned test parses fixtures of the
current persisted shapes through the new schema.

- **Zero Firestore migration.** Existing documents keep their exact keys
  and shapes, and the schema above accepts them unchanged; Firestore doc IDs
  are `encodeURIComponent(taskKey())`, and `work:` cannot collide with
  `owner/repo#123` because `:` is not in the repo-name charset
  (`model.ts`'s `taskIdSchema` regex).
- Run state changes flow back to the WorkItem via the same outbox pattern
  the drain already uses.

## API and auth

### Resources and scopes

Resource-oriented REST under `apps/console/src/app/api/work/v1/`: the URL
names a resource, never the caller's role. Two resources exist in v1 —
`items` and `runs` — with fleet-management resources (`grants`, `caps`)
arriving when those leave configuration. Authorization is by **OAuth2
scope**, the standard mechanism for trust levels, so the split between
"a run reporting on itself" and "someone issuing work" is a property of
the token, not of the path.

Scopes are additive — a principal may hold several:

| Scope           | Confers                                                                                          | Typically held by                                                  |
| --------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `work.agent`    | The `runs/:runId` routes for **one** run; this scope is always bound to a run ID                 | A dispatched run (`agent:run/<runId>`)                             |
| `work.operator` | Issue and follow work; cancel/redispatch own items; attach links                                 | Granted humans, requester agents, services                         |
| `work.admin`    | Everything `work.operator` can, on any item; `grants`/`caps` management once those are resources | Admin principals (the console's `isAdmin`); admin implies operator |

What is fixed is not how many scopes a principal holds but **what each
issuer may confer**: a GitHub Actions OIDC token yields `work.agent` bound
to the run it authenticates as and nothing else; grant configuration
yields `work.operator` and `work.admin`. A run that must request
follow-up work is a legitimate future case — an LCARS-minted token
(sub-project 4) carrying both `work.agent` and `work.operator` — allowed
by this design, just not by v1's issuers.

**`items` — issuing and following work.**

| Route                        | Scope                                      | Purpose                                                                                                                                            |
| ---------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /items`                | `work.operator`                            | Create a WorkItem. Caller supplies `requestId`; replays dedupe (same contract as the orchestrator's `duplicate-request`). Returns `202` + item ID. |
| `GET /items/:id`             | `work.operator`                            | Full state: spec, work state, runs, links, results, events.                                                                                        |
| `GET /items`                 | `work.operator`                            | List/filter by state, principal, target repo.                                                                                                      |
| `POST /items/:id/cancel`     | `work.operator` (own) / `work.admin` (any) | Stop.                                                                                                                                              |
| `POST /items/:id/redispatch` | `work.operator` (own) / `work.admin` (any) | Parked → ready; mints a fresh run. API-native analog of today's reply triggers.                                                                    |
| `POST /items/:id/links`      | `work.operator`                            | Attach a typed reference (a human or requester adding evidence).                                                                                   |

**`runs/:runId` — a run reporting on itself.** Every route requires
`work.agent` bound to that exact run ID; keyed by run, not item, because a
run may only ever speak for itself.

| Route                        | Purpose                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /runs/:runId`           | The run's spec and item snapshot. The first authenticated call performs the run binding and records an `acknowledged` event. |
| `POST /runs/:runId/renew`    | Renew the orchestrator lease.                                                                                                |
| `PUT /runs/:runId/progress`  | Replace the run's single bounded progress note (the native form of the protocol's one edited progress comment).              |
| `POST /runs/:runId/links`    | Attach a typed reference on the run's behalf (session, PR).                                                                  |
| `POST /runs/:runId/results`  | Report a typed result.                                                                                                       |
| `POST /runs/:runId/complete` | Terminal report `{ ok, summary }` — the native form of today's hosted completion call; `ok: false` parks the item.           |

The `runs` routes are the **complete** channel a run has to the control
plane. That list is the contract the later non-GitHub backend depends on;
extending it is fine, bypassing it is not. Each route declares its
required scope; the gate checks the scope and, for `work.agent`, the run
binding — a token whose scope does not cover the route gets `403`.

Create is one Firestore transaction, then `202`: validate → reserve the
idempotency key → write the WorkItem in state `ready` → enqueue a `work`
outbox entry (`admit`) carrying the admission intent. The transaction is
the whole decision; `requestRun` is its side effect, called by the outbox
drain (same lease/fencing machinery as `dispatch-run`) with the `work:`
anchor and the item's `requestId`, which the orchestrator already dedupes.
A crash anywhere after commit is repaired by the next drain; a crash before
commit leaves nothing behind. This is the orchestrator's own rule — the
decision and its side effect are never one step — applied one layer up.

- **Idempotency is transactional.** The reservation is a document keyed by
  `(principal, requestId)` written in the same transaction as the WorkItem,
  so concurrent replays of one request contend on one document and
  converge on one ULID instead of minting several. A replay returns the
  reserved item; it can never observe a WorkItem without an admission
  entry, because both are written together or neither is.
- The 30-minute reconcile sweep additionally repairs any `ready` item whose
  `admit` entry is missing or stuck, the same way it already retries stuck
  `dispatch-run` deliveries.

Status is poll-only in v1 (the CLI offers `--watch` by polling); no
streaming.

Busy-task behavior surfaces the orchestrator's existing decisions verbatim:
`task-busy` → `409`, `duplicate-request` → the existing item.

### Authorization and admission

Authentication says who is calling; this section says what they may do.
Both are deliberately explicit because agent-initiated ingress removes the
human-per-task gate that labels provide today.

- **Grants are per principal, per pipeline.** Configuration is a list of
  `{ principal, pipelines: [...], maxLiveRuns, admin? }`; a grant confers
  `work.operator`, and `admin: true` adds `work.admin`. A principal with
  no grant is rejected at the gate; a granted principal requesting a
  pipeline outside its list gets `403`. This is the mechanism behind the
  "not every agent may trigger Claude" decision.
- **Admission caps.** `maxLiveRuns` bounds how many of a principal's
  WorkItems may be `ready` or `running` at once; a global cap, sized to
  the autoscaler's capacity configuration, bounds the whole fleet.
  Exceeding either returns `429` with `Retry-After`; nothing is queued on
  the caller's behalf.
- **Ownership.** `cancel` and `redispatch` are allowed to the item's
  `origin.principal` and to `admin` principals only. Reads are open to any
  granted principal (single-tenant fleet). The `runs/:runId` routes require `work.agent` bound to that run.
- **Console actions map to the same rules.** A console user acts as
  `user:<github-login>` (from the existing Auth.js session), and the
  console's existing `isAdmin` flag is the `admin` grant.
- **An agent can be the admin.** Nothing distinguishes a human from an
  agent at this layer: an agent acting as the fleet's administrator is a
  principal (e.g. `svc:lcars-admin`, a service-account identity under the
  Google issuer in v1) with `admin: true` in grants, holding
  `work.operator` and `work.admin` together. Its first unmet need —
  managing grants and caps through the API rather than configuration —
  is what promotes `grants`/`caps` from configuration to resources.

### Auth: standard OAuth 2.0 resource server

The API is a plain OAuth2 resource server (RFC 6750 bearer tokens):
validate the JWT against the issuer's OIDC discovery document + JWKS, check
audience, then apply the entry's claim predicates. Implemented with `jose`
(standard library, already what `github-actions-oidc.ts` uses) — no
hand-rolled crypto, no bespoke verifier plugins.

- **Trusted issuers are configuration**, not code:
  `[{ issuerUrl, audience, claimPredicates, principalMapping }]`. v1 ships
  two entries:
  - Google (`accounts.google.com`) — workstations via ADC, homelab
    services via service accounts. Chosen because it is free today, not
    because it is contractual.
  - GitHub Actions (`token.actions.githubusercontent.com`) — calls _from
    runs_. Signature, issuer, and audience are **not** sufficient for this
    issuer: any GitHub repository can mint a token requesting our audience.
    The entry therefore carries the fail-closed claim predicates the
    completion path already enforces
    (`apps/console/src/lib/github-actions-oidc.ts`'s
    `assertCompletionOidcClaims`): `repository` in the control-plane
    allow-list, `ref` is `refs/heads/main`, `event_name` is
    `workflow_dispatch`, and `workflow_ref`/`job_workflow_ref` pinned to
    the worker workflows and the fleet finalizer on `main`, per route.
    Every predicate fails closed; none is expressed by audience alone.
- **Migrating off Google is a config change**: add any standard IdP
  (self-hosted Keycloak/Dex or managed) as an entry, move callers, delete
  the Google entry. No API or data change. Google for v1 was ratified on
  2026-08-24; the likely successor is LCARS-minted tokens (sub-project 4)
  issued from the console's existing Auth.js GitHub login, published under
  the console's own JWKS so LCARS becomes one more issuer entry.
- **Principals are LCARS-native, never issuer subjects.**
  `origin.principal` stores identifiers like `user:jlapenna`, `svc:cron`,
  `agent:run/<runId>`, produced by the issuer's mapping table. Raw issuer
  subjects go in the audit event as detail only, so stored history never
  encodes an identity provider.
- **`agent:run/<runId>` requires a run binding, not just a trusted token.**
  The predicates above prove "a trusted worker workflow on an allowed
  repository", not "the worker for _this_ run" — today's completion route
  stops there and trusts the body's run reference. For the run-lifecycle
  routes the mapping additionally binds the token's
  `(repository_id, run_id)` claims to the orchestrator run named in the
  request: the first authenticated call binds them transactionally, and
  only if that run is live, was dispatched by `GitHubActionsExecutor` to
  that repository, and is not already bound; every later call must present
  the same pair. A token that fails the binding gets `403`, never a
  fallback principal.
  The existing hosted completion route adopts the same binding in v1 so
  the two run-facing paths cannot drift apart.
- Authorization is an explicit allowlist keyed on the LCARS-native
  principal (same spirit as `AGENT_BOT_LOGINS`), so it survives issuer
  swaps untouched.
- The expected eventual third issuer class is **LCARS-minted per-run
  tokens** (needed by the non-GitHub execution backend; see
  [Execution](#execution-abstraction)). Not built in v1.

### CLI

`lcars work create|status|list|cancel|redispatch|link`, mapping 1:1 onto
the routes. The CLI acquires and attaches the caller's token invisibly
(today: ADC identity token; tomorrow: whatever the replacement IdP mints).

## Ingress adapters

All roads create or update WorkItems; nothing else writes them.

- **API ingress (v1, new)** — the `POST /items` path. The agent-initiated
  channel and the reason this program exists.
- **Webhook ingress (existing, untouched in v1)** — `interpretDelivery`
  keeps driving GitHub-anchored orchestrator tasks exactly as today.
  Deliberately not migrated: label-dispatch works, and its interaction
  surface is GitHub-native by nature. A later sub-project wraps each label
  dispatch in a WorkItem (`channel: 'webhook'`, issue auto-linked) so the
  console shows one unified work list — the model already has the fields.
- **Cron ingress (future)** — a scheduler reads `schedule` on template
  WorkItems and mints occurrences through the same internal create path as
  the API. Reserved fields only in v1.
- **Console ingress (future)** — Quick Tasks eventually become
  `channel: 'console'` WorkItems instead of issue-creators. Deferred with
  the same reasoning as webhook.

## Execution abstraction

The seam goes where the orchestrator already has one: the outbox. A
`dispatch-run` entry is handed to an **`Executor`** —
`dispatch(run, workItem)` plus best-effort `cancel(run)` — selected per
task. Everything upstream (mutex, lease, retry) is already
execution-agnostic.

### Backend 1 (v1): `GitHubActionsExecutor`

Today's `workflow_dispatch` drain
(`apps/console/src/lib/orchestrator-dispatch.ts`), promoted to the first
implementation of the interface. One real change: worker workflows
(`claude.yml` etc.) grow a `work_id` input alongside the issue anchor. For
a native task with `target.repo`, the workflow runs on that repo as usual,
but the agent's prompt/spec comes from `GET /items/:id` (authenticated with
the run's Actions OIDC token) instead of an issue body, and lease renewal +
results flow back through the API. GitHub Actions remains the queue and
credential broker in v1 — deliberately, since the driver is agent-initiated
_ingress_, not runner independence.

**Targetless items are rejected in v1.** `spec.target` stays optional in
the schema for the later `QueueExecutor`, but this backend cannot launch
without a repository: the workflow URL and the installation token both come
from `target.repo`. While `GitHubActionsExecutor` is the only backend,
`POST /items` returns `400` for an item with no `target.repo`, or one whose
repository is outside the control-plane allow-list of repositories with the
worker workflows installed. The API never accepts work no backend can
launch.

### Backend 2 (later): `QueueExecutor`

The actual de-GitHub-ing, as its own sub-project. LCARS keeps a claimable
run queue (Firestore, same lease/fencing pattern as the outbox). The
runner-autoscaler — which already builds and launches the runner
containers — grows a second trigger: poll queue depth, launch the same
runner image in "direct" mode, where a bootstrap claims a run, pulls the
spec via API, runs the agent CLI, and reports via API. No Actions queue, no
workflow YAML, no JIT registration. Runner identity becomes an LCARS-minted
per-run token.

## Deliverables, results, and evidence

Typed results on the WorkItem, reported through `POST /runs/:runId/results`
by the run itself:

- `pr` — `{ repo, number, url, headSha }`. **The only kind wired
  end-to-end in v1.**
- `report` — bounded markdown body, for answer-shaped work.
- `artifact` — `{ storageRef, contentType, digest }`, backed by GCS with a
  bounded upload contract in the spirit of
  [quick-task-evidence](../../quick-task-evidence.md). Schema-ready only.
- `message` — a pointer to something delivered elsewhere (Telegram, Slack).
  Schema-ready only.

**Attribution.** The #815 lesson — a run's own deliverable cannot be
identified by bot login — is solved today by claim-marker scraping. For
native tasks, attribution comes from the auth layer instead: a result is
written by a verified `agent:run/<runId>` principal, so "which run produced
this" is token-bound fact. GitHub-side claim markers are still written on
PRs (other tooling reads them), but the control plane's own record no
longer depends on them.

**Verification.** `verify-deliverable` gains an API mode for native tasks:
the gate is "the WorkItem has ≥1 result from this run, or an explicit
failure report" — one HTTP call, no GitHub scraping. In v1 every native task must deliver a `pr` result or an explicit failure; result-kind rules per task shape arrive with non-PR results.

**Failure and parking.** A run reporting `ok: false`, or exhausting the
existing auto-retry budget, moves the WorkItem to `parked` with the failure
summary stored on the item — the native equivalent of `status:needs-human`
plus the outcome comment. `POST /items/:id/redispatch` is the reply-trigger
analog. Deliberate v1 gap: parked native tasks are visible in console/CLI
but page no one; notification wiring (Telegram) is sub-project 2.

## Dispatched-agent protocol in native mode

`agent-protocol` is written against an issue. A native task has none, so
v1 adds a **native mode** section to the shared protocol that maps each
issue-side action to its API form. Label-driven behavior is untouched;
this is additive.

**Native mode is transitional, not the destination.** The end state
(decided 2026-08-24) is that dispatched agents are GitHub-issue agnostic:
they receive a WorkItem, interact only through the `runs` routes, and never
touch an issue themselves. Once sub-project 5 makes label-driven work a
WorkItem too, every issue-side affordance in the table below — the eyes
reaction, the progress comment, the parking label, the outcome comment —
becomes a **control-plane projection**: the outbox drain writes it to the
linked issue in response to WorkItem events, exactly as it posts outcome
comments today. At that point the "issue mode" column is deleted from the
protocol and the agent-facing contract is the `runs` resource alone.

| Protocol section                                                          | Issue mode (today)                   | Native mode (v1)                                                                                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Takeover comment                                                       | Comment naming the resume command    | `POST /runs/:runId/links` kind `session` with the session ID and resume command as `note`; the console renders the takeover affordance from it     |
| 2. Eyes-reaction acknowledgement                                          | 👀 on the issue                      | Implicit: the first authenticated `GET /items/:id` performs the run binding and records an `acknowledged` event                                    |
| 3. One edited progress comment                                            | Single comment, edited in place      | `PUT /runs/:runId/progress` — one bounded note, replaced in place                                                                                  |
| 4. Parking                                                                | `status:needs-human` label + comment | `POST /runs/:runId/complete` with `ok: false` and the summary; the item moves to `parked`                                                          |
| 5. Deliverable rule                                                       | PR carrying the attempt-claim marker | Same PR and marker (the marker's intent ID is already the orchestrator run ID, now `work:<ulid>/r<n>`), plus `POST /runs/:runId/results` kind `pr` |
| 6–11. Push early, budget, CI reruns, headless-sync, identity, hard limits | unchanged                            | unchanged                                                                                                                                          |
| 12. Session status channel                                                | `lcars session title`                | unchanged — telemetry never depended on GitHub                                                                                                     |

Two implementation notes fall out of the table:

- The attempt-marker grammar (`libs/dispatch-contracts/src/marker.ts`)
  must accept the `work:` run-ID form; a pinned test covers both forms.
- PRs from native tasks are authored by the same bot logins as today, so
  `agent-automerge.yml` treats them identically. A native task's PR body
  references the item (`Work: work:<ulid>`) rather than `Fixes #N`.

## Console surface

Two pages, deliberately minimal in v1, behind the console's existing auth
wall:

- `/work` — the work list: state, title, channel, principal, age; parked
  items surfaced first. This page is why later ingress unification is worth
  doing: it eventually becomes the one place to see everything.
- `/work/[id]` — spec, event timeline, runs (linking into existing session
  detail pages via a `session` link, which telemetry already provides),
  links, results, and three actions: cancel, redispatch, attach link.

## Error handling

Mostly inherited from the orchestrator, which is the point of building on
it:

- Create is idempotent by `requestId`.
- Busy tasks refuse (`409`) or queue via the existing `queueIfBusy`.
- Executor dispatch failures retry through the existing outbox lease
  machinery.
- Silent runner death → lease expiry → bounded auto-retry → parked.
- New surface follows house style: strict zod schemas, bounded strings,
  fail-closed validation. WorkItem state transitions are a validated state
  machine with the bounded `events[]` audit pattern.

## Retention

WorkItems are retained indefinitely in v1; they are the audit trail.
Idempotency reservation documents carry an `expiresAt` (30 days) so a
Firestore TTL policy can reap them — enabling that policy is an
infrastructure change under the usual maintainer-approval rule and is not
part of the v1 code change.

## Testing

Mirror the orchestrator's proven pattern:

- A store contract spec run against both memory and Firestore stores
  (`store-contract.spec.ts` precedent).
- State-machine unit tests for WorkItem transitions.
- API route tests with stubbed verified tokens; table-driven specs for
  principal mapping.
- Pinned wire-format tests for `work:` anchor keys and result schemas (the
  quick-task-digest lesson: wire formats get pinned, or they drift).
- No real git in unit tests.
- Console E2E additions stay off while the suite is paused (#1049). The
  real-path proof is a smoke run: one native task dispatched end-to-end
  producing a PR on a test repo.

## Sequencing

Five sub-projects, each its own spec → plan → PR cycle. This document is
the full design for #1 and pins the seams for the rest.

1. **v1 (this spec):** `libs/work`, anchor generalization, REST API +
   OAuth2 resource-server gate, `lcars work` CLI, `work_id` path through
   `GitHubActionsExecutor`, PR results, parking/redispatch, minimal console
   pages.
2. **Notifications:** parked-work paging (Telegram) + console polish.
3. **Cron ingress:** scheduler minting occurrences from `schedule`.
4. **`QueueExecutor`:** direct runner mode in the autoscaler + LCARS-minted
   run tokens.
5. **Ingress unification:** webhook label-dispatch and Quick Tasks become
   WorkItems, issue-side affordances become control-plane projections of
   WorkItem events, and `agent-protocol` collapses to the `runs` resource —
   agents become GitHub-issue agnostic.

## Non-goals (v1)

- Migrating existing GitHub-anchored tasks or Quick Tasks to WorkItems.
- Streaming/long-poll status.
- Non-PR result kinds beyond schema definitions.
- Targetless (no `target.repo`) work items — rejected at the API until
  `QueueExecutor` lands.
- Notifications for parked work.
- Any change to the dispatched-agent protocol for label-driven work.
- MCP transport (wraps the REST API later if wanted).
- A review dispatch mode for native tasks; a review is expressed as a task
  with a `github-pr` link when someone needs one.
- LCARS-minted tokens (sub-project 4) and any issuer beyond Google + GitHub
  Actions.
- A default pipeline or an implicit "any pipeline" grant.
