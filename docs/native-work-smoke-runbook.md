# Native work item production smoke runbook

The first real native work item, run end to end against production on
2026-08-27: an item created through the work API with no GitHub issue behind
it, dispatched by the console's orchestrator with the `work` workflow input,
executed by the claude lane, delivered as a pull request carrying the
attempt-claim marker, and settled by the finalizer's completion call bound to
the run by its dispatch marker. This is the sub-project 1 proof from the
[native work items design](superpowers/specs/2026-08-23-native-work-items-design.md)
(#1502), Plan 3 Task 6.

## Safety rules

- The smoke change is a one-line README edit under a "Native work smoke"
  heading. The PR it produces is **closed, never merged**.
- Create the item with the `work-create.yml` workflow (or a signed-in console
  session). Do not mint personal service-account tokens or add IAM bindings
  for a smoke.
- One item at a time: `AGENT_LCARS_WORK_MAX_LIVE_RUNS` is `2` in production
  and this smoke should never need the second slot.
- Cancel only through `POST /api/work/v1/items/{id}/cancel`. Cancelling from
  the console's runs view does not settle a native run today (#1530).
- Anything that fails is a finding on #1502 with the run URL — fix forward,
  never paper over it.

## Contract under test

| Step              | Expected                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /items/{id}` | `201` with the item view; `runs[0].runId` = `work:<id>/r1`, state `running` once the drain dispatches                                                                           |
| Actions run       | `claude.yml` run titled `native work: Claude issue agent [dispatch:g1:work:<id>/r1]` with `issue` empty and `work` = `{"id","spec"}`                                            |
| Lane              | claim/eyes/assignee steps skipped; brief `anchor.type` is `work` with `html_url` = `https://lcars.jlapenna.net/work/<id>`; telemetry session doc carries `intentId`             |
| Deliverable       | a PR by the fleet login whose body carries `<!-- attempt-claim:<ATTEMPT_ID> -->` and `Work: work:<id>`; `verify-deliverable` passes on the marker alone with no `/issues/` call |
| Completion        | the finalizer posts by run; `GET /items/{id}` shows `state: done`, `runs[0].result.ref` = the PR URL, and the session listed under the item                                     |
| Cancel after done | `POST /items/{id}/cancel` → `409`                                                                                                                                               |

## 1. Create the item

```bash
gh workflow run work-create.yml \
  -f title='Native work smoke: add a line to README' \
  -f description='Append one line to README.md under a new "Native work smoke" heading: the ISO date of this run. Open a PR; do not merge.' \
  -f repo=jlapenna/agent-lcars -f pipeline=claude
gh run watch "$(gh run list --workflow work-create.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

The step summary names the item id and its first run.

## 2. Follow the run

```bash
gh run list --workflow claude.yml --limit 3
gh run watch <run-id>
```

## 3. Check the item

```bash
gh workflow run work-create.yml -f action=get -f id=<id>
```

The run's step summary shows `state`, and each run's `runId`, `state`, and
`result` (or open `https://lcars.jlapenna.net/work/<id>` signed in).

## 4. Close the PR, confirm cancel is refused

```bash
gh pr close <pr-number> --comment "Native work smoke — evidence only, not merged."
gh workflow run work-create.yml -f action=cancel -f id=<id>   # step log: -> 409
```

## Source evidence

Run of 2026-08-27, on console revision `022fff0` (#1531 + #1532 on top of
Plan 3, #1527) with the `workflow:work-create` grant live.

| What              | Value                                                                                                                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Item              | `01M107KR3X6VDH7NZ4JDXZNSS2` — https://lcars.jlapenna.net/work/01M107KR3X6VDH7NZ4JDXZNSS2                                                                                                                                                                                                |
| Create            | [work-create run 33039333794](https://github.com/jlapenna/agent-lcars/actions/runs/33039333794): `PUT … -> 201` at 04:24:54Z, `origin: {principal: "workflow:work-create", channel: "api"}`, `runs[0].runId = work:01M107KR3X6VDH7NZ4JDXZNSS2/r1`, state `running`                       |
| Dispatch          | [claude.yml run 33039341065](https://github.com/jlapenna/agent-lcars/actions/runs/33039341065) created 04:24:56Z, titled `native work: Claude issue agent [dispatch:g1:work:01M107KR3X6VDH7NZ4JDXZNSS2/r1]`                                                                              |
| Lane              | `dispatch-bootstrap.claim` skipped; telemetry sidecar started with `intent-id: work:01M107KR3X6VDH7NZ4JDXZNSS2/r1`; "Prepare current dispatch brief" and "Resolve agent budget" succeeded; agent step 04:25:12Z → 04:29:40Z                                                              |
| Deliverable       | [PR #1533](https://github.com/jlapenna/agent-lcars/pull/1533) by `app/claude` at 04:29:12Z; body carries `Work: work:01M107KR3X6VDH7NZ4JDXZNSS2` and `<!-- attempt-claim:g1:work:01M107KR3X6VDH7NZ4JDXZNSS2/r1 -->`; "Run post-agent gates" succeeded (marker-only `verify-deliverable`) |
| Completion        | `fallback-finalize / finalize` 04:29:43Z → 04:30:04Z: "Derive trusted completion evidence" and "Return completion observation to the broker" succeeded; both park/preserve steps skipped                                                                                                 |
| Item after        | [get run 33039675801](https://github.com/jlapenna/agent-lcars/actions/runs/33039675801): `state: done`, `runs[0].state: finished`, `result: {ok: true, summary: "pull-request", ref: "https://github.com/jlapenna/agent-lcars/pull/1533"}`, `updatedAt` 04:30:01.880Z                    |
| Session           | `b887e54c-883c-4fc2-a197-6659f534eae4` under the item, `runId` `work:…/r1`, title "Native work smoke: README line", status "opened PR #1533 (native work smoke), not auto-merging per task request", transcript in `gs://agent-lcars-session-transcripts/runs/33039341065/…`             |
| Cancel after done | [cancel run 33039711081](https://github.com/jlapenna/agent-lcars/actions/runs/33039711081): `POST …/cancel -> 409`                                                                                                                                                                       |
| Cleanup           | PR #1533 closed unmerged at the end of the run                                                                                                                                                                                                                                           |

Create-to-done wall clock: 5 min 7 s (04:24:54Z → 04:30:01Z).

Not directly observed from outside the runner: the brief's `anchor.html_url`
(the brief is a file on the runner, not logged). It is pinned by
`prepare.test.sh`'s native case; the agent's own PR body referencing
`Work: work:<id>` shows it read a native brief.

Observed follow-ups: the run renders under "unattributed attempts" on the
console dashboard (#1530); the lane's default prompt still offers the
issue-mode park recipe (#1528) — the agent did not need it this time.

## Sub-project 2: parked work on the Bridge (2026-08-27)

Sub-project 2 landed as [PR #1535](https://github.com/jlapenna/agent-lcars/pull/1535)
(`fcf7b8e`): a Bridge "Parked work" panel, `/work` in the primary nav, a
create form on `/work`, and native-run links plus cancel-by-dispatch-marker
(#1530), shipped by
[deploy-console run 33049007495](https://github.com/jlapenna/agent-lcars/actions/runs/33049007495).
[PR #1536](https://github.com/jlapenna/agent-lcars/pull/1536) (`d6659a0`)
followed with a `redispatch` action on `.github/workflows/work-create.yml`,
letting a parked item be re-run without minting a new one. This smoke drives
a native item through a full park → Bridge-panel-render → redispatch → park
again → cancel cycle to prove both land together.

| Step              | Expected                                                                                                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /items/{id}` | `201`; item created via `work-create.yml`                                                                                                                                                                                                                                   |
| r1 parks          | agent step succeeds, "Run post-agent gates" fails (no deliverable, by design), finalizer "Return completion observation to the broker" succeeds, park/preserve steps skipped; `GET` shows `state: "parked"`, `runs[0].result: {ok: false, summary: "outcome-gate-failure"}` |
| Bridge panel row  | the parked item is the first real row the Bridge "Parked work" panel renders — the panel itself is unit-tested; this is the maintainer's eyeball check against the live Bridge                                                                                              |
| Redispatch        | `POST /items/{id}/redispatch -> 200`; item `state: running`; `runs[1].runId = work:<id>/r2`                                                                                                                                                                                 |
| r2 parks          | parks the same way as r1; `GET` shows `state: parked`; item `updatedAt` moves from r1's park time to r2's, so the panel's "parked … ago" follows the latest park                                                                                                            |
| Cancel            | first `POST /items/{id}/cancel -> 200` (`state: canceled`); second `-> 409`                                                                                                                                                                                                 |

### Source evidence

| What          | Value                                                                                                                                                                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy        | [deploy-console run 33049007495](https://github.com/jlapenna/agent-lcars/actions/runs/33049007495) shipped PR #1535 (`fcf7b8e`)                                                                                                                                                                                |
| Item          | `01M111J6RZFRC6TECEX1ABEW79` — https://lcars.jlapenna.net/work/01M111J6RZFRC6TECEX1ABEW79                                                                                                                                                                                                                      |
| Create        | [work-create run 33049440147](https://github.com/jlapenna/agent-lcars/actions/runs/33049440147): `PUT … -> 201`; title "Native work smoke: park", description asking the agent to end with `PARK smoke-test — no work requested`                                                                               |
| r1            | [claude.yml run 33049453010](https://github.com/jlapenna/agent-lcars/actions/runs/33049453010): agent step succeeded, "Run post-agent gates" failed (no deliverable, by design), finalizer "Return completion observation to the broker" succeeded, park/preserve steps skipped; workflow conclusion `failure` |
| Item after r1 | [get run 33049611109](https://github.com/jlapenna/agent-lcars/actions/runs/33049611109): `state: "parked"`, `runs[0].result: {ok: false, summary: "outcome-gate-failure"}`, session status `"smoke-test — no work requested; parking per brief instructions"`                                                  |
| Redispatch    | [redispatch run 33049692857](https://github.com/jlapenna/agent-lcars/actions/runs/33049692857), dispatched from the #1536 branch (`feat/work-redispatch-action`) with `--ref`: `POST …/redispatch -> 200`, item `running`, `runs[1].runId = work:01M111J6RZFRC6TECEX1ABEW79/r2`                                |
| r2            | [claude.yml run 33049702626](https://github.com/jlapenna/agent-lcars/actions/runs/33049702626): parked the same way as r1                                                                                                                                                                                      |
| Item after r2 | `get`: `state: parked`; item `updatedAt` moved from `2026-08-27T07:24:12.694Z` (r1) to `2026-08-27T07:27:51.863Z` (r2)                                                                                                                                                                                         |
| Cancel        | first `POST …/cancel -> 200` (`state: canceled`); second `POST …/cancel -> 409`                                                                                                                                                                                                                                |

Commands used:

```bash
gh workflow run work-create.yml \
  -f title='Native work smoke: park' \
  -f description='PARK smoke-test — no work requested' \
  -f repo=jlapenna/agent-lcars -f pipeline=claude

gh workflow run work-create.yml -f action=get -f id=01M111J6RZFRC6TECEX1ABEW79

gh workflow run work-create.yml --ref feat/work-redispatch-action \
  -f action=redispatch -f id=01M111J6RZFRC6TECEX1ABEW79

gh workflow run work-create.yml -f action=cancel -f id=01M111J6RZFRC6TECEX1ABEW79
```

Residual/known: native runs still appear in the Bridge's agent-activity
"unattributed" group, but now link to `/work/<id>` — the attribution half of
#1530. The panel reads the 200 newest native items before filtering (see the
comment in `page.tsx`).

## Sub-project 3: cron ingress (2026-08-27)

Sub-project 3 landed as [PR #1538](https://github.com/jlapenna/agent-lcars/pull/1538)
(`28eb9cc`): a schedules resource (`ScheduleStore`), `POST /schedules/tick`,
a cron grammar with deterministic slot ids, GitHub-OIDC tick auth scoped to
`work.cron`, the `/work/schedules` page, `work-schedules-tick.yml` on
`2-59/5 * * * *`, and `schedule-create`/`schedule-disable` actions on
`work-create.yml`, shipped by
[deploy-console run 33055030072](https://github.com/jlapenna/agent-lcars/actions/runs/33055030072).
This smoke drives a schedule through create → tick (minting exactly one item
for the due slot) → the minted item running and parking like any other
native item → disable, to prove cron ingress lands end to end.

| Step                                    | Expected                                                                                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /schedules/{id}` (schedule-create) | `201`; schedule view carries a seeded `lastSlotAt` — first-slot seeding, so the schedule can never mint a past slot                                                               |
| `POST /schedules/tick`                  | mints exactly one item for the due slot, with a deterministic slot-derived item id; already-minted slots are skipped                                                              |
| Minted item                             | carries `origin: {principal: "cron:<scheduleId>", channel: "cron"}` and runs like any native item (claim/eyes/assignee steps skipped, brief resolved, dispatched to the pipeline) |
| `POST /schedules/{id}/disable`          | `200`; `enabled: false`, `lastItemId` set to the most recently minted item                                                                                                        |

Commands used:

```bash
gh workflow run work-create.yml \
  -f action=schedule-create \
  -f title='Cron smoke: park' \
  -f description='PARK cron-smoke' \
  -f cron='58 8 * * *' \
  -f repo=jlapenna/agent-lcars -f pipeline=claude

# GitHub had not yet started the new schedule; manual fallback from main:
gh workflow run work-schedules-tick.yml --ref main

gh workflow run work-create.yml -f action=get -f id=01M116EJSY6NTCMF62YXHDXR60

gh workflow run work-create.yml -f action=schedule-disable -f id=01M116EJSY6NTCMF62YXHDXR60
```

### Source evidence

| What             | Value                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy           | [deploy-console run 33055030072](https://github.com/jlapenna/agent-lcars/actions/runs/33055030072) shipped PR #1538 (`28eb9cc`)                                                                                                                                                                                                                                                                                                 |
| Schedule         | `01M116EJSY6NTCMF62YXHDXR60` — https://lcars.jlapenna.net/work/schedules                                                                                                                                                                                                                                                                                                                                                        |
| schedule-create  | [work-create run 33055609928](https://github.com/jlapenna/agent-lcars/actions/runs/33055609928): `PUT …/schedules/01M116EJSY6NTCMF62YXHDXR60 -> 201` at 08:47:49Z, `cron: "58 8 * * *"`, title "Cron smoke: park", description asking the agent to `PARK cron-smoke`, `enabled: true`, `lastSlotAt: "2026-08-27T08:47:49.530Z"` (first-slot seeding)                                                                            |
| Manual tick      | GitHub had not started the new `schedule`-event runs by 09:03Z, so a tick was dispatched manually from `main`: [work-schedules-tick run 33056841130](https://github.com/jlapenna/agent-lcars/actions/runs/33056841130), `success`, response `{"ticked":1,"minted":[{"scheduleId":"01M116EJSY6NTCMF62YXHDXR60","itemId":"01M1171FE03SFA06DAW6M5CXMY"}],"skippedCap":[],"disabled":[],"errors":[]}` — the 08:58Z slot minted once |
| Item's run       | [claude.yml run 33056854261](https://github.com/jlapenna/agent-lcars/actions/runs/33056854261): conclusion `failure` (PARK by design)                                                                                                                                                                                                                                                                                           |
| Item after       | [get run 33057026944](https://github.com/jlapenna/agent-lcars/actions/runs/33057026944): `state: "parked"`, `origin: {principal: "cron:01M116EJSY6NTCMF62YXHDXR60", channel: "cron"}`, `runs[0].result: {ok: false, summary: "outcome-gate-failure"}`                                                                                                                                                                           |
| schedule-disable | [schedule-disable run 33057092699](https://github.com/jlapenna/agent-lcars/actions/runs/33057092699): `POST …/disable -> 200`, `enabled: false`, `lastItemId: "01M1171FE03SFA06DAW6M5CXMY"`, `disabledReason: "operator"`                                                                                                                                                                                                       |

Lag note: newly added scheduled workflows can lag before GitHub starts firing
their `schedule` event — the new cron had not produced a single
`schedule`-triggered run by 09:03Z, 15 minutes after schedule-create. The
OIDC pin backing `work-schedules-tick.yml` accepts `workflow_dispatch` from
`main`, which is the manual fallback used above and the one to reach for
whenever a cron smoke can't wait out GitHub's schedule-activation lag.

## Sub-project 6: session resume and reaper (2026-08-27)

Sub-project 6 (session resume and persistence) adds a `resume-session`
lane step (era-split like every other local action in `agent-lane.yml` —
see [Published actions](published-actions.md)) and the
`work-session-pin-tick.yml` scheduled workflow (`17,47 * * * *`), which
authenticates with a GitHub-Actions-OIDC bearer scoped to `work.reaper`
(`work-auth.ts`'s fourth verification branch, no grant-list entry needed)
and rewrites `expireAt` forward on every session belonging to a still-open
(running/parked) native item, so Firestore's native TTL policy on
`sessions.expireAt` never reaps a session out from under an item that is
still in play. Landed as [PR #1543](https://github.com/jlapenna/agent-lcars/pull/1543)
(`0374789d`), shipped by
[deploy-console run 33094008052](https://github.com/jlapenna/agent-lcars/actions/runs/33094008052).

This smoke proves the **persistence half only** (the reaper sweep), and
only for the open items this run's API reads actually returned — not
universal coverage; see the pagination note under check 3 below. The
**`--resume` half is NOT proven here** — see the note at the end of this
section.

Two things had never run outside a test before this smoke: `firebase-admin`
driven by only a WIF external-account credentials file plus an exported
project id (no ambient GCP runtime), and `touchSessionExpiry` writing
against real production Firestore rather than an emulator. Because GitHub
drops most scheduled runs in this repo (#1542), the schedule was not
trusted to fire on its own — every run below was a manual
`workflow_dispatch`.

| #   | Check                              | Result                                                                                                                                                              |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Job runs green                     | **PASS** — run 33095379007, conclusion `success`                                                                                                                    |
| 2   | OIDC read authenticated and listed | **PASS** — `work.reaper` bearer verified; found 2 open items (both `parked`, 0 `running`), 2 sessions total                                                         |
| 3   | Write moved `expireAt` forward     | **PASS** — before/after read directly against Firestore; delta +3m15s from dispatch time, `lastActivityAt` untouched (watermark-only write, as designed)            |
| 4   | Reaper identity is read-only       | **PASS** — structural on two independent axes; live probe also confirmed a third, stronger gate (see below)                                                         |
| 5   | First-run behaviour                | **PASS** — this was literally the first run of the workflow ever (run history shows only this dispatch and the throwaway probe below); nothing pre-pinned, no error |

### 1-2. The job ran green and the OIDC read worked

[Run 33095379007](https://github.com/jlapenna/agent-lcars/actions/runs/33095379007),
dispatched `workflow_dispatch` against `main` at 16:51:25Z, conclusion
`success` at 16:52:17Z (48s). The "Run the pin sweep" step logged:

```
pinned 2 session(s): c8a433c6-6d46-4f18-9abb-1bb2425cb940, 66e18401-100d-4491-8183-bfe78cb39f13
```

Both sessions belonged to `parked` native items (0 items were `running` at
dispatch time) — the sweep's two-query shape (`state=running` then
`state=parked`) found nothing in the first bucket and both open items in
the second, and touched both without error, confirming the `work.reaper`
OIDC bearer authenticated and the read against the work API succeeded.

### 3. The write moved `expireAt` forward (before/after)

No open native item with a session existed at the start of this proof (the
sub-project 1-5 smoke items had all been closed or canceled) — a fresh
one was created so the check would be real, per the runbook's own
practice:

```bash
gh workflow run work-create.yml -f action=create \
  -f title='Sub-project 6 proof: session-pin-tick smoke (park immediately)' \
  -f description='... PARK sub-project-6-smoke — no work requested ...' \
  -f repo=jlapenna/agent-lcars -f pipeline=claude
```

| What                | Value                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Item                | `01M121WWNXZ95KT6E3AVCN7B0Y`, created by [work-create run 33095028437](https://github.com/jlapenna/agent-lcars/actions/runs/33095028437): `PUT … -> 201` at 16:47:27Z                                                                                  |
| Dispatch            | [claude.yml run 33095045778](https://github.com/jlapenna/agent-lcars/actions/runs/33095045778), parked by design (conclusion `failure`, matching sub-project 2's park shape)                                                                           |
| Item confirmed open | [get run 33095230890](https://github.com/jlapenna/agent-lcars/actions/runs/33095230890) at 16:49:46Z: `state: "parked"`, session `c8a433c6-6d46-4f18-9abb-1bb2425cb940`                                                                                |
| `expireAt` BEFORE   | `2027-08-27T16:48:56.809Z` — read directly from `projects/agent-lcars/databases/(default)/documents/sessions/c8a433c6-…` via Firestore `runQuery` (REST `GET` 404s on this doc id form; `runQuery` filtered on `sessionId` instead, per prior finding) |
| Pin-tick dispatch   | run 33095379007 (above), executed 16:52:14Z                                                                                                                                                                                                            |
| `expireAt` AFTER    | `2027-08-27T16:52:11.858Z` — same `runQuery`, re-read after the run completed                                                                                                                                                                          |
| Delta               | **+3m15s**, exactly the gap between the two reads/writes; `lastActivityAt` stayed `2026-08-27T16:48:56.809Z` in both reads — confirming `touchSessionExpiry` rewrote only `expireAt`, matching its own doc comment                                     |

The second pinned session (`66e18401-…`) turned out to belong to
`01M1171FE03SFA06DAW6M5CXMY`, the "Cron smoke: park" item from the
sub-project 3 proof above — `schedule-disable` had disabled the _schedule_
but the _item_ itself was never canceled, so it was still sitting `parked`
five hours later. Its `expireAt` moved to the same `2027-08-27T16:52:11.858Z`
in the same write batch — real evidence the sweep touched both open items
the API returned in this run, not just the one created for this proof, and
an incidental finding that sub-project 2/3 smokes should cancel their
minted items when they park, not just disable the schedule.

This is evidence for the open items this run's reads actually returned,
not universal coverage. Both `state=running` and `state=parked` requests
in `session-pin-tick.ts` pass `limit=200`, and that limit is applied
before the state filter — `work-router.ts`'s `listNativeTasks` orders by
`workId` desc, so a request really returns "the open items among the 200
newest native items," not "the 200 newest open items." Once total native
item history passes 200, an older still-open item can fall outside every
future sweep and its session can expire out from under it. That
pagination gap is a known follow-up, tracked in
[#1546](https://github.com/jlapenna/agent-lcars/issues/1546), not fixed
here.

Cleanup: `01M121WWNXZ95KT6E3AVCN7B0Y` canceled via
[cancel run 33095653252](https://github.com/jlapenna/agent-lcars/actions/runs/33095653252):
`POST …/cancel -> 200`.

### 4. The reaper identity is read-only

Structural on two independent layers, neither grant-list-dependent:

- `work-auth.ts`'s `authenticateWorkRequest` hardcodes the principal for a
  verified session-pin-tick OIDC token — `scopes: new Set(['work.reaper'])`
  — built directly in code, never looked up from `AGENT_LCARS_WORK_GRANTS`.
  There is no config path that could grant this token `work.operator`.
- `work-router.ts`'s `create`/`cancel`/`redispatch` procedures are built
  from the `operator` middleware, which checks only
  `principal.scopes.has('work.operator')`. `list`/`get` use the separate
  `reader` middleware, which accepts `work.operator` **or** `work.reaper`.
  A `work.reaper`-only principal fails `operator`'s check unconditionally.

A live negative probe was attempted, not just reasoned about statically:
a throwaway branch (`chore/sp6-reaper-probe-throwaway`, deleted after)
added a debug step calling
`POST /api/work/v1/items/01M121WWNXZ95KT6E3AVCN7B0Y/cancel` with the same
bearer the pin sweep mints, dispatched via `workflow_dispatch --ref
chore/sp6-reaper-probe-throwaway`
([run 33095525130](https://github.com/jlapenna/agent-lcars/actions/runs/33095525130)).
It surfaced a **third, earlier gate**: `github-actions-oidc.ts`'s
`assertSessionPinTickOidcClaims` pins `job_workflow_ref` to
`…/work-session-pin-tick.yml@refs/heads/main` and `ref` to
`refs/heads/main` exactly, so a token minted from any other branch is
rejected at authentication — the run's own "Run the pin sweep" step failed
with `GET /items?state=running -> 401` before the debug cancel step could
even run. That is a real, live-confirmed rejection, just one layer higher
than the operator-vs-reader boundary — exercising that specific boundary
live would require dispatching the debug step from `main` itself, which
this proof deliberately did not do. The two static findings above cover
it with high confidence instead.

### 5. First-run behaviour

This was the first time this workflow has ever executed successfully in
production — `gh run list --workflow work-session-pin-tick.yml` shows
exactly two runs total: the production dispatch above and the throwaway
probe. No scheduled `17,47 * * * *` tick had fired by the time of this
proof, consistent with #1542. With nothing ever pinned before, the sweep
simply pinned every open item's sessions it found (2 of them) and
completed without error — there is no "first run" special case in the
code, and none was needed.

### `--resume` is NOT proven by this smoke

Sub-project 6 also ships a `resume-session` lane step. That step and
`direct-runner.sh` both call the `runner resume` subcommand out of the
sidecar bundle baked into the runner image
(`apps/runner-autoscaler/runner-image/Dockerfile`), and that image is built
on the homelab host — not from this repo's CI. Until the runner image is
rebuilt from `main` to pick up sub-project 6's sidecar changes, the
`resume-session` step cannot be exercised for real. Today, calling it
against a stale image degrades to starting a fresh session rather than
failing outright — worth knowing if a redispatch or resume looks like it
"worked" but didn't actually resume anything.
