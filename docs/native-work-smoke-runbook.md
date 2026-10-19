# Native work item production smoke runbook

The current production route is Work API → GitHub Work admission →
orchestrator → QueueExecutor → direct container. Webhooks, the public
GitHub-anchor endpoint, and Console Retry all use that one admission service,
which derives and validates a Work specification before it enters the route;
no hosted provider workflow, raw-GitHub runner, or console-specific fallback
is supported. The dated sections below are historical evidence only, not
operational instructions.

This runbook drives that route on **real useful work**, per
[Development proof uses real work](testing-policy.md#development-proof-uses-real-work):
exercise the normal intake, dispatch, execution, and delivery paths with a
genuine outcome. Do not invent a no-op task, disposable README edit, or
throwaway PR to manufacture a green run or telemetry, and do not close or
discard useful delivery to replay the dated smokes recorded below.

## Select the work

- Pick genuinely useful work within the authorized scope. Inspect current
  Task/Run/session ownership and recent delivery evidence; do not collide with a
  human's or another agent's claim. A bot assignment alone is not active
  execution, and an empty queue is not a reason to invent work.
- Keep an **existing GitHub issue on its own anchor** through its normal fleet
  intake under the [GitHub label contract](github-label-contract.md), preserving
  the requested canonical `agent:*` choice and checking actual admission and
  ownership. Do not also create a detached native item: freeform issue text in
  its description does not claim, assign, or bind that issue. Continue existing
  owned work through its supported path instead of duplicating implementation.
- The standalone native-item recipe below is for a **useful standalone task
  with no existing GitHub issue anchor**. Its `work:<id>`, `/items/{id}`, and
  `/work/{id}` examples are specific to that native item; follow an existing
  issue's authoritative Task/Run/session and PR through its owner/console view.
- For a standalone native item, choose the deliverable honestly: default PR
  delivery for an implementation,
  and `deliverable: report` only when the outcome is findings rather than a
  change. Successful report delivery requires its private
  `<!-- agent-result:v1:report:$ATTEMPT_ID -->` record with the attempt claim in
  the same private outcome file **and** the complete
  final findings in the same round (at most 16,384 characters; oversize is refused, not truncated) —
  a final message alone is insufficient, and a PR fails a report item. Only
  stored `deliverable: report` opt-in enables this contract; do not infer it
  from task text.
- Preserve provider choice, owner/collision checks, the pipeline's supported job
  sizing and priority, and every operational approval boundary. Choose the
  pipeline the work needs; do not raise priority or invent oversized jobs.
- Create the item through the existing supported intake — `work-create.yml` for
  a standalone implementation item, or a signed-in console session when you need
  `deliverable: report` or a non-default priority. Do not mint personal
  service-account tokens or add IAM bindings.
- Submit one item at a time. Intake accepts work into the durable queue;
  QueueExecutor reserves fleet capacity before claiming a run.
- Cancel only through `POST /api/work/v1/items/{id}/cancel` (the console's Cancel
  button, `work-actions.tsx` → `workRouter.cancel`); the runs-view cancel path
  that could not settle a native run is gone (#1530, #1611). Cancel useful
  delivery only when it is genuinely no longer wanted, never to end a run sooner.
- Record the exact Run URL and true failure on the existing owning work/issue;
  fix forward and never paper over the result.

## What each phase proves (separate observations)

Admission, provider execution, publication, landing, and report completion are
distinct — one passing does not imply the next. PR publication is observed from
the latest successful `finished` Run's `pull-request` result and PR reference,
not from item state. Identify the latest Run by its run id and creation order;
`runs[0]` need not remain the latest after continuations. Record the item id,
actual Run id, path exercised and useful result; a dispatch or worker exit alone
does not prove delivery.

Item state is derived separately from the Task and latest Run. For a successful
finished Run with current delivery ownership, the item stays `running` until
the delivery binding reaches `complete` for that Run, including any required
runtime acceptance after protected merge. Failed or parked results can instead
make it `failed` or `parked`. Only the unbound compatibility path can settle
`done` directly from a successful finished Run. An optional `runs[n].delivery`
records the Run binding when present; its absence alone proves neither landing
nor completion. See [the owning derivation](../libs/work/src/derive.ts).
A binding whose runtime gate is `unknown` does not establish that no runtime
acceptance is needed. Preserve actual delivery ownership and do not infer Task
completion from a merge or invent runtime evidence.

| Observation                 | What you actually look at                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Admission                   | `PUT /items/{id}` returns `201` with the item view and initial `work:<id>/r1` Run. A queued, unclaimed Run proves admission only.                                                                                                                                                                                                                                        |
| Provider execution          | the direct worker claims the native Run and records actual provider-process start and session history against that Run id; the item brief has `anchor.type: work`; `GET /items/{id}` and the console show the Run lifecycle. No GitHub Actions run or title marker is required.                                                                                          |
| PR publication (run result) | the latest Run settles `state: finished` with `result.ok: true`, `result.summary: pull-request`, and `result.ref` = the PR URL; the fleet-login PR references `Work: work:<id>`. This records publication independently of item state and landing.                                                                                                                       |
| Protected landing           | observe required CI and the protected merge **on the PR itself** — required checks going green and the merge commit on the base branch. A finished publication Run is insufficient; landing alone does not complete a delivery binding with remaining runtime acceptance.                                                                                                |
| Report completion           | a `deliverable: report` item requires the private `<!-- agent-result:v1:report:$ATTEMPT_ID -->` record with the attempt claim in the same outcome file **and** complete final findings in the same round (at most 16,384 characters; oversize refused, never truncated). A bare final message is insufficient and a PR fails it; verify the actual accepted Run outcome. |

On the PR path, a successful `finished` Run with its `pull-request` result and
PR reference proves publication. Watch required CI and protected merge on the
PR, then any remaining delivery/runtime acceptance; item `done` is not a
universal publication or landing shortcut. On the report path require the
private outcome record plus complete findings and the accepted Run outcome;
there is nothing to land.

`POST /items/{id}/cancel` after the item is `done` returns `409`.

## 1. Create the standalone native item

Use the useful standalone task selected above, with no existing GitHub issue
anchor. For an implementation item on the default PR path:

```bash
gh workflow run work-create.yml \
  -f title='<real task title>' \
  -f description='<authorized useful standalone outcome and acceptance>' \
  -f repo=<owner/repo> -f pipeline=<claude|codex|opencode>
gh run watch <actual-work-create-workflow-run-id>
```

Select the actual workflow dispatch for this submission from its actor, time
and inputs; do not watch an unrelated latest dispatch. This admission workflow
is separate from the native execution Run.

`work-create.yml`'s `create` action sends a plain implementation spec (default
PR delivery). For a `deliverable: report` item or a non-default priority, create
it through a signed-in console session, which exposes those fields. The step
summary names the item id and its first run.

## 2. Follow the run

Use the signed-in `https://lcars.jlapenna.net/work/<id>` item view with an
existing authorized Work session, or the supported read workflow:

```bash
gh workflow run work-create.yml -f action=get -f id=<id>
```

Read the summary of that actual workflow dispatch and follow the native Run
until terminal. Its Task/Run record and session history are authoritative;
direct workers do not create a GitHub Actions execution run to watch. A
finished publication Run can coexist with a `running` item while delivery
ownership continues. Work API access requires the existing application grant;
console admin status or a bare Google token is insufficient. See
[Work API access](../OPERATIONS.md#work-api-access) for supported authentication;
do not mint credentials or widen IAM to follow this recipe.

## 3. Confirm the useful outcome — publication is not landing

```bash
gh workflow run work-create.yml -f action=get -f id=<id>
```

The run's step summary shows `state`, and each run's `runId`, `state`, and
`result` (or open `https://lcars.jlapenna.net/work/<id>` signed in). Read them by
path, not as one green light:

- **Implementation (PR) path:** the latest successful Run's `state: finished`,
  `result.summary: pull-request`, and PR `result.ref` record publication.
  Independently confirm required CI and protected merge on the PR, then actual
  remaining delivery/runtime acceptance before treating the Task as complete.
  A merge alone does not resolve a runtime gate recorded as `unknown`.
- **Report path:** confirm the private
  `<!-- agent-result:v1:report:$ATTEMPT_ID -->` record with the attempt claim in
  the same private outcome file **and** complete final findings in the same
  round (at most 16,384 characters; oversize is refused, not truncated).
  Verify the accepted Run outcome; a bare final message settles nothing, and
  a PR fails a report item.

Then let normal delivery and cleanup take their course. Do not close useful
delivery to end the run sooner; the dated smokes below were evidence for their own
fixes, not a delivery contract to copy.

## Narrow synthetic canaries

Fixtures, mocks, deterministic regression tests, and narrowly scoped synthetic
canaries still belong where they protect a specific contract or safely exercise
a failure — label their evidence as a supplement, not as real-work acceptance of
the full workflow. Do not manufacture a production task, delay, retry, cancel,
or provider event to verify a documentation change such as this one.

## Current schedule mutation revision gate

Read a schedule's current `revision`, then send it as `expectedRevision` in
edit, delete, enable, or disable requests. Bodyless toggles return 400; a
stale revision returns 409 without applying the change. The `work-create`
workflow's `schedule-disable` action reads the revision first and fails on
409 so a concurrent operator change cannot be reported as a successful
disable.

## Historical smoke ledgers

The dated smoke ledgers from 2026-08-27 through 2026-09-07 (native item
creation, parked work, cron ingress, QueueExecutor canaries, ingress
unification, session resume and reaper, resumable conversations, tagged-gate
re-gating, OpenCode/Codex session continuity and Slack threads) were evidence
for their own fixes and predate the QueueExecutor cutover. They are retained
at the [pre-fold revision](https://github.com/jlapenna/agent-lcars/blob/47c5769bc54cb7258af00619b4315b1c7c09c004/docs/native-work-smoke-runbook.md#historical-evidence-pre-cutover-non-executable),
not in this runbook; issues and PRs preserve the chronology.
