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
