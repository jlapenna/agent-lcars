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

| Question                       | Decision                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| First end-to-end consumer      | Agent-initiated work via API                                                                                                               |
| Deliverable model              | Generic typed results; only the PR result path wired in v1                                                                                 |
| GitHub's role for native tasks | None required. Native-first: console + API are the interaction surface; GitHub issues/PRs are optional typed _links_ (references/evidence) |
| API transport                  | Versioned REST on the console + `lcars work` CLI subcommands; MCP can wrap later                                                           |
| Auth                           | Standard OAuth 2.0 resource server; trusted OIDC issuers as configuration; no Google dependency in the contract                            |
| Structure                      | New `libs/work` layer above the orchestrator (approach B); the orchestrator keeps its admission-mutex job unchanged                        |

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
  `{ title, description, pipeline?, target?: { repo, ref? }, mode }`.
  `target` is optional — that is the GitHub-optional part.
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
transactional outbox. One change: `TaskId` becomes a discriminated union —
`{ kind: 'github', repo, issue }` | `{ kind: 'work', workId }` — with
`taskKey()` emitting the existing `repo#issue` string for GitHub anchors and
`work:<ulid>` for native ones.

- **Zero Firestore migration.** Existing task documents keep their exact
  keys and shapes; Firestore doc IDs are `encodeURIComponent(taskKey())`,
  and `work:` cannot collide with `owner/repo#123` because `:` is not in
  the repo-name charset (`model.ts`'s `taskIdSchema` regex).
- Run state changes flow back to the WorkItem via the same outbox pattern
  the drain already uses.

## API and auth

### Routes

Versioned REST under `apps/console/src/app/api/work/v1/`, next to the
existing control-plane routes.

| Route                        | Purpose                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /items`                | Create a WorkItem. Caller supplies `requestId`; replays dedupe (same contract as the orchestrator's `duplicate-request`). Returns `202` + item ID. |
| `GET /items/:id`             | Full state: spec, work state, runs, links, results, events.                                                                                        |
| `GET /items`                 | List/filter by state, principal, target repo.                                                                                                      |
| `POST /items/:id/cancel`     | Operator/requester stop.                                                                                                                           |
| `POST /items/:id/redispatch` | Parked → ready; mints a fresh run. API-native analog of today's reply triggers.                                                                    |
| `POST /items/:id/links`      | Attach a typed reference.                                                                                                                          |
| `POST /items/:id/results`    | Report a typed result. Executor-facing; restricted to the run's own verified identity.                                                             |

Create is thin: validate → write WorkItem → `requestRun` with the `work:`
anchor → `202`. Status is poll-only in v1 (the CLI offers `--watch` by
polling); no streaming.

Busy-task behavior surfaces the orchestrator's existing decisions verbatim:
`task-busy` → `409`, `duplicate-request` → the existing item.

### Auth: standard OAuth 2.0 resource server

The API is a plain OAuth2 resource server (RFC 6750 bearer tokens):
validate the JWT against the issuer's OIDC discovery document + JWKS, check
audience, done. Implemented with `jose` (standard library, no framework
lock-in) — no hand-rolled crypto, no bespoke verifier plugins.

- **Trusted issuers are configuration**, not code:
  `[{ issuerUrl, audience, principalMapping }]`. v1 ships two entries:
  - Google (`accounts.google.com`) — workstations via ADC, homelab
    services via service accounts. Chosen because it is free today, not
    because it is contractual.
  - GitHub Actions (`token.actions.githubusercontent.com`) — calls _from
    runs_, reusing the existing `COMPLETION_OIDC_AUDIENCE` trust
    machinery's approach.
- **Migrating off Google is a config change**: add any standard IdP
  (self-hosted Keycloak/Dex or managed) as an entry, move callers, delete
  the Google entry. No API or data change.
- **Principals are LCARS-native, never issuer subjects.**
  `origin.principal` stores identifiers like `user:jlapenna`, `svc:cron`,
  `agent:run/<runId>`, produced by the issuer's mapping table. Raw issuer
  subjects go in the audit event as detail only, so stored history never
  encodes an identity provider.
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

Typed results on the WorkItem, reported through `POST /items/:id/results`
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
failure report" — one HTTP call, no GitHub scraping. Mode-specific rules
(implement ⇒ result kind `pr`) stay, expressed against result types.

**Failure and parking.** A run reporting `ok: false`, or exhausting the
existing auto-retry budget, moves the WorkItem to `parked` with the failure
summary stored on the item — the native equivalent of `status:needs-human`
plus the outcome comment. `POST /items/:id/redispatch` is the reply-trigger
analog. Deliberate v1 gap: parked native tasks are visible in console/CLI
but page no one; notification wiring (Telegram) is sub-project 2.

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
   WorkItems.

## Non-goals (v1)

- Migrating existing GitHub-anchored tasks or Quick Tasks to WorkItems.
- Streaming/long-poll status.
- Non-PR result kinds beyond schema definitions.
- Notifications for parked work.
- Any change to the dispatched-agent protocol for label-driven work.
- MCP transport (wraps the REST API later if wanted).
