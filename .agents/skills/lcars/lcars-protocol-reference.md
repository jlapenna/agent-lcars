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
the current design. `verify-deliverable.sh` keeps the deliverable contract
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
  `report-outcome` entry that failed a prior GitHub call (rate limit,
  transient 5xx) stays `pending` and is retried on the next drain — dispatch
  or completion, or this scheduled sweep, whichever runs next. This is why
  an outcome comment can appear on the issue noticeably after your run
  actually finished.

None of this involves a ledger comment, a `generation` counter, or a
Firestore authority lease on a shared document that a headless agent could
inspect or contend with directly — `libs/orchestrator/README.md` is the
whole contract if you need more than this summary.

## Session-resume: why each pipeline's handoff line differs

> Which line to actually post is in
> the shared agent protocol's takeover section.
> This is the background for why the three pipelines differ.

`fleet-claude-agent-session` (packages/fleet-tools) is Claude-specific by
construction: it discovers transcripts only under `~/.claude/projects`, authenticates with
`CLAUDE_CODE_OAUTH_TOKEN`, and hands off to `claude --resume`. The console's
`TAKEOVER_COMMAND_RE` (`apps/console/src/lib/action-items.ts`) is
`/(\S*claude-agent-session(?:\.sh)?\s+resume\s+[\w-]+)/` — it matches the
bin name (and historical `.sh` paths) and requires whitespace after `resume`, so it does not
match `resume-archive`, and it does not generalize per agent. A Codex or
OpenCode run that borrowed the name would be posting a command that cannot
work; naming the gap honestly is the correct outcome, not a hole to paper
over.

The two non-Claude pipelines' situations genuinely differ, and a takeover
comment should say which one it is rather than treating "no resume tooling"
as identical for both:

- **Codex:** no live-resume command, but the run's transcript IS archived to
  GCS once the job ends (`codex.yml`'s telemetry sidecar +
  `libs/telemetry/src/lib/codex-transcript-adapter.ts`), and the session's
  console page shows an "Archived transcript" note naming that `gs://` URI
  (`apps/console/src/app/sessions/[id]/session-header.tsx`). The console does
  **not** render the transcript's contents: `getSessionDetail`
  (`apps/console/src/lib/session-detail.ts`) only fetches and parses one when
  `sessionAgent(doc) === 'claude-code'`. So say the transcript is archived to
  GCS, not that it is "viewable in the console" — `gcloud storage cat` on that
  URI prints the raw JSONL, the same tool `resume-archive` uses. No
  `resume-archive` equivalent exists for Codex today.
- **OpenCode:** nothing is archived at all. The telemetry sidecar's watch
  roots are `~/.claude/projects` and `~/.codex/sessions`
  (`apps/telemetry-watcher/src/lib/runner.ts`'s `startSidecar`) — OpenCode
  writes to neither, and no OpenCode transcript adapter exists
  (`libs/telemetry/src/lib/transcript-adapter.ts`'s `TRANSCRIPT_ADAPTERS`), so
  an OpenCode run ships no transcript and no session doc at all.

**Why this section is written so defensively:** it used to say the script did
not exist in this repo at all, and stayed that way long after it landed. Every
pipeline's agents read that and posted "resume tooling is not yet available" —
exactly the string `TAKEOVER_COMMAND_RE` cannot match — so the takeover
affordance stayed dark on this repo's own issues while working for every other
repo the fleet watches. `resume` also only reaches a session while its JIT
runner is alive, which is why `resume-archive` must be mentioned alongside it
rather than instead of it.
