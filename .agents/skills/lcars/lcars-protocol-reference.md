# LCARS Protocol — Situational Reference

Background for [`lcars-protocol.md`](lcars-protocol.md): how dispatch,
reconciliation, and the session-resume story actually work. None of it is
something a dispatched agent acts on directly, which is why it is not in the
file every dispatch reads before it can do anything (agent-lcars#1210). Read
it when you are changing this machinery, or when the summary genuinely is not
enough.

## Dispatch: how a run gets started

- **Dispatch (current, #1015):** a webhook delivery is interpreted by
  `apps/console/src/lib/orchestrator-ingest.ts`'s `interpretDelivery`, pure
  and stateless: an `issues`/`pull_request` `labeled` event whose label is
  `agent:claude`/`agent:codex`/`agent:opencode` requests mode `implement`
  (issue or PR); the same on a PR with `review:claude`/`review:codex`/
  `review:opencode` requests mode `review`. Each delivery is evaluated on
  its own — there is no cross-check against the anchor's full current label
  set, no contradictory-multi-label detection, and no stale-label cleanup.
  What actually prevents two runs is `libs/orchestrator`'s per-task mutex:
  a request while a run is already live is refused (`task-busy`); a retried
  delivery (same GitHub delivery ID) maps back to the run it already
  created instead of starting a second one (`duplicate-request`). Your
  attempt identity, `$ATTEMPT_ID`, is `g<generation>:<intentId>`, where
  `intentId` is literally the orchestrator's run ID
  (`<repo>#<issue>/r<generation>`) — passed to your workflow as the
  `broker_intent_id`/`broker_generation` `workflow_dispatch` inputs by the
  orchestrator's outbox drain, not re-derived or re-verified by you.
- **Native work items (Plan 2/3):** an item with no GitHub issue or PR
  anchor enters through `PUT /api/work/v1/items/{id}`, is minted as a
  `work:<ulid>/r<n>` run, and is dispatched with a `work` workflow input
  (no `issue`). It is completed the same way as any other run — the
  finalizer binds to it by the dispatch marker
  (`[dispatch:g<generation>:<intentId>]`), not by issue number.

## `agent:*` vs `review:*` — which label means which mode

> What to actually do in each mode is in
> the shared agent protocol's "Dispatch mode" table. This
> section is only how a label becomes a mode.

Tagging an **issue** with `agent:claude`/`agent:codex`/`agent:opencode`
dispatches `mode: implement`. Tagging a **pull request** with the same
`agent:*` label dispatches `mode: implement` too (#567). A pull request
tagged instead with `review:claude`/`review:codex`/`review:opencode`
dispatches `mode: review` (#565/#568, revised by #567 once the maintainer
picked `review:*` as the dedicated review trigger rather than overloading
`agent:*` for both meanings). The two label families are independent: a PR
may carry `agent:*`, `review:*`, both, or neither, and each drives its own
dispatch mode when applied (`libs/dispatch-contracts/src/pipelines.ts`'s
`AGENT_LABELS`/`REVIEW_LABELS`). `review:*` is not a recognized label at all
on a plain issue — there is no diff to review.

#815 is why the gate no longer accepts a bare review, or a bare push to the
anchor PR, from your bot login on its own: both were inference clauses that
could not tell your run's work from an unrelated bot touch in the same
window.

The GitHub App subscribes to issue, issue-comment, and pull-request events.
`orchestrator-ingest.ts` acts only on the `labeled` action for both label
families (#565) and on `issue_comment`'s `created` action for reply
commands; `unlabeled`, `closed`, `reopened`, and any other action are
received but ignored today (`ignore('unhandled-action')` /
`ignore('unhandled-event')`) — there is no relabel/close-driven cleanup in
the current design. The native outcome verifier keeps the deliverable contract
aligned for both modes regardless of how the run was requested.

## Reconciliation and lease recovery

There is no ledger to reconcile today. `.github/workflows/dispatch-reconcile.yml`
calls `/api/control-plane/reconcile` every 30 minutes (also
`workflow_dispatch`-able); that handler is `Orchestrator.sweepExpired()`
(`libs/orchestrator/src/orchestrator.ts`) followed by an outbox drain
(`apps/console/src/lib/orchestrator-dispatch.ts`). What it actually does:

- **Lease expiry, not liveness polling.** A live run holds a 2-hour lease
  (`decide.ts`'s `LEASE_MS`) that only your own dispatch/report/renew calls
  extend. If your job dies silently — runner loss, a timeout with no
  completion callback, anything that never reaches `expireLease` on its
  own — the sweep is what eventually notices: once the lease is past due,
  the run is marked `lost` and the task's mutex is released. There is
  nothing for you to hand-repair here; you do not need to reconstruct or
  edit any state.
- **Bounded, automatic retry.** Immediately after marking a run `lost`, the
  sweep requests a fresh run for the same task with the same
  pipeline/params — unless the task has gone `lost` more than
  `MAX_AUTO_RETRIES` (2) times in a row since its last `finished`/
  `canceled` settlement, in which case it's left parked instead
  (`status:needs-human`, via the outcome comment the outbox drain posts).
  A manual reply/label request still works on a parked task at any time —
  it is not blocked by the exhausted auto-retry budget, only unattempted by
  the sweep itself.
- **The outbox drain also retries stuck deliveries.** A `dispatch-run` or
  `report-outcome` entry is transactionally leased to one drain at a time.
  An explicit GitHub-call failure (rate limit, transient 5xx) releases it to
  `pending`; a crashed drain's lease expires after five minutes. Either path
  makes the entry eligible for the next drain — dispatch or completion, or
  this scheduled sweep, whichever runs next. This is why an outcome comment
  can appear on the issue noticeably after your run actually finished.

None of this involves a ledger comment, a `generation` counter, or a
Firestore authority lease on a shared document that a headless agent could
inspect or contend with directly — `libs/orchestrator/README.md` is the
whole contract if you need more than this summary.

## Operator-side session archive recovery

This section describes the one supported operator-side recovery mechanism:
recover a completed run from its durable archive.

`fleet-claude-agent-session` (packages/fleet-tools) is Claude-specific,
archive-only recovery. Use:

```sh
fleet-claude-agent-session resume-archive <gs://.../<session-id>.jsonl|run-id>
```

The tool accepts either an exact archived transcript URI or one QueueExecutor
run ID (for example, `work:<ulid>/r1` or `octo/example#42/r1`). It resolves a
single archive, downloads it into the current checkout's
`~/.claude/projects/` directory, and prints the matching local
`claude --resume` command. It never discovers a live runner, uses runner OAuth
credentials, or reaches into an ephemeral container; the archive is the only
supported session-recovery boundary.

Do not post the retired `fleet-claude-agent-session resume <id>` command or
describe a live JIT resume path. Console cleanup for that old command parser
is tracked separately; it is not a compatibility promise for agents to rely
on.

For other pipelines, state the actual archive behavior without inventing a
resume command:

- **Codex:** its completed run transcript is archived to GCS. The console can
  show the archive URI, but no Codex archive-resume tool exists today.
- **OpenCode:** the runner captures a bounded, sanitized metadata export under
  `runs/<run-id>/opencode/<session-id>.jsonl`; it is durable but not
  timeline-renderable and has no resume command.
