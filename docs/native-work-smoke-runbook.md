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

## Sub-project 4: QueueExecutor — acceptance still incomplete (2026-08-28)

This is an evidence/status record, **not** a completion claim. The direct
queue path has reached a real autoscaler-launched container three times, but
no canary has yet produced the required successful deliverable and `done`
item state.

| Attempt         | Evidence and outcome                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First canary    | The queue executor placed a direct runner, but `prepare-agent-dispatch` failed because `RUNNER_TEMP` was not exported. [PR #1576](https://github.com/jlapenna/agent-lcars/pull/1576) fixed that bootstrap contract.                                                                                                                                         |
| Second canary   | The repaired bootstrap reached `direct-runner.sh`, then failed with `claude: command not found`. [PR #1577](https://github.com/jlapenna/agent-lcars/pull/1577) installs Claude Code in the runner image and smoke-checks `claude --version` during its build.                                                                                               |
| Published image | The repaired image was published from Agent LCARS revision `4d30d30b230aac09c12c6f1bdf6a79a0abe90867` as `sha256:ad7b6e022ed0bdcca366dca1b2520001c6178ee413cdbc5224a8d88fe8e95b96`.                                                                                                                                                                         |
| Third canary    | Item [`01M138S62PHGVQ5AQNBP1NRW66`](https://lcars.jlapenna.net/work/01M138S62PHGVQ5AQNBP1NRW66) minted a `queue` run, was claimed by a direct container, and did **not** trigger `claude.yml`. Claude itself then exited because its weekly quota resets at **2026-08-30 00:00 UTC**; the item was canceled and the temporary queue flags were rolled back. |

**Next action:** after that quota reset, run exactly one more canary and
require the direct container to finish with a real deliverable and the item
to reach `done`; only then may sub-project 4 be marked complete. Until then,
production remains on the rolled-back flags (console rollback:
[PR #1579](https://github.com/jlapenna/agent-lcars/pull/1579)).

## Sub-project 5: ingress unification — issue-side claim/park projections (2026-08-27)

Sub-project 5 landed as [PR #1545](https://github.com/jlapenna/agent-lcars/pull/1545)
(`cfbb0e77`): every anchor now carries a `work` payload
(`apps/console/src/lib/work-from-github.ts`), the lane's own claim step
(`.github/actions/claim-issue`) is skipped whenever a caller passes
`control-plane-projections: true`, and the console's outbox drain projects
the 👀 reaction + fleet assignee on dispatch and the park label + comment on
a no-deliverable completion instead
(`apps/console/src/lib/orchestrator-dispatch.ts`'s `claimGithubAnchor` and
`handleReportOutcome`), shipped by
[deploy-console run 33091025926](https://github.com/jlapenna/agent-lcars/actions/runs/33091025926).
Unlike sub-projects 1-3, this smoke drives the **real GitHub-issue trigger**
(the `agent:claude` label webhook), not `work-create.yml`, because the thing
under test is what happens to an ordinary issue-anchored dispatch now that
the agent lane no longer claims it itself.

| Step             | Expected                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Label the issue  | `issues.labeled` webhook → console `request()` → `drain()` dispatches `claude.yml` with a derived `work` input, same request                                             |
| Claim projection | 👀 reaction and fleet assignee appear on the issue without the lane's own claim step running                                                                             |
| Lane             | "Claim the issue as the agent fleet" step present but `skipped`                                                                                                          |
| Work payload     | the run's `work` input `spec.title`/`spec.description` trace verbatim to the issue's title/body                                                                          |
| Park projection  | on a no-deliverable finish, the console posts the failure/park comment (with the "No auto-retry will follow" clause) and applies `status:needs-human`, not the finalizer |

Commands used:

```bash
gh issue create --repo jlapenna/agent-lcars \
  --title "[infra proof] #1502 sub-project 5: claim/park projection smoke (DO NOT IMPLEMENT)" \
  --body-file proof-issue-body.md            # -> #1547
gh issue edit 1547 --repo jlapenna/agent-lcars --add-assignee agent-lcars-bot
gh issue edit 1547 --repo jlapenna/agent-lcars --add-label agent:claude   # the real trigger
gh run list --repo jlapenna/agent-lcars --workflow claude.yml --limit 3
gh api repos/jlapenna/agent-lcars/issues/1547/reactions
gh api repos/jlapenna/agent-lcars/issues/1547/timeline
```

### Source evidence

| What                      | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy                    | [deploy-console run 33091025926](https://github.com/jlapenna/agent-lcars/actions/runs/33091025926) shipped PR #1545 (`cfbb0e77`), console revision deployed 16:08:03Z                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Issue                     | [#1547](https://github.com/jlapenna/agent-lcars/issues/1547) — pre-assigned `agent-lcars-bot` at issue-claim time (16:14:05Z, before the label trigger — see note below), no reactions yet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Trigger                   | `gh issue edit 1547 --add-label agent:claude` at 16:14:14-16Z (timeline `labeled` event 16:14:15Z, actor `jlapenna`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **1. Claim projection**   | 👀 reaction by `agent-lcars[bot]` at **16:14:21Z** — 6-7s after the label — via `gh api .../issues/1547/reactions`. **PASS** (reaction only — see note; the assignee half was unmeasured on this issue and was verified separately by the #1550 run below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Dispatch                  | [claude.yml run 33092172953](https://github.com/jlapenna/agent-lcars/actions/runs/33092172953) created 16:14:20Z, titled `#1547: Claude issue agent [dispatch:g1:jlapenna/agent-lcars#1547/r1]`; Cloud Run log: `orchestrator webhook delivery processed {status:200, body:{runId:'jlapenna/agent-lcars#1547/r1', dispatched:true}}` at 16:14:22.660Z                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **2. Lane claim skipped** | job 98587617433, step **"Claim the issue as the agent fleet"** → `status: completed`, `conclusion: skipped` (`gh api .../actions/jobs/98587617433`). **PASS**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **3. Work payload**       | run logs: `work: {"spec":{"title":"[infra proof] #1502 sub-project 5: claim/park projection smoke (DO NOT IMPLEMENT)","description":"## Infrastructure proof — not a work request\n\n...","pipeline":"claude","target":{"repo":"jlapenna/agent-lcars"}}}` — title/description byte-for-byte the issue's own; no truncation marker (well under the 16,384-char/32,768-byte budget). **PASS**                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Agent run                 | "Run Claude Code" succeeded; agent ended `PARK ...` per the issue's own instructions; "Run post-agent gates" failed (no deliverable, by design, matching sub-project 2's park shape); workflow conclusion `failure`; `fallback-finalize / finalize` job: "Derive trusted completion evidence" → `outcome-kind=outcome-gate-failure`, "Return completion observation to the broker" succeeded, "Report and park bootstrap-independent failure" **skipped** (control-plane projects it instead)                                                                                                                                                                                                                                                                                                                                     |
| Run doc after             | Firestore `orchestrator-runs/jlapenna%2Fagent-lcars%231547%2Fr1`: `state: finished`, `result: {ok: false, summary: "outcome-gate-failure"}`, `updatedAt: 16:16:11.289Z`; Cloud Run log: `orchestrator completion processed {status:200, body:{runId, state:'finished'}}` at 16:16:12.560Z                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **4. Park projection**    | **FAIL.** No comment, no `status:needs-human` label, ever appeared on #1547 — confirmed by `gh api .../issues/1547` and `.../timeline` repeatedly through 16:23Z, and again after a manual `dispatch-reconcile.yml` run ([33092838874](https://github.com/jlapenna/agent-lcars/actions/runs/33092838874)) whose own `/api/control-plane/reconcile` call logged `{reported: []}`. Root-caused via a direct Firestore read: the run's `report-outcome` outbox entry (`orchestrator-outbox/outcome%2Fjlapenna%2Fagent-lcars%231547%2Fr1`) sat `state: pending, attempts: 0` — never claimed, alongside **162 other pending `report-outcome` entries fleet-wide**, oldest from 2026-08-21T04:08:14Z. Filed as [#1548](https://github.com/jlapenna/agent-lcars/issues/1548) with full evidence and a head-of-line-blocking hypothesis. |
| **5. Cleanup**            | [#1547 closed](https://github.com/jlapenna/agent-lcars/issues/1547#issuecomment-5442090551) with a summary comment recording the PASS/FAIL split and linking #1548; no PR was produced (by design — the issue asked the agent to park, not implement).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Note on the assignee measurement: this run's throwaway issue was
pre-assigned `agent-lcars-bot` at issue-claim time, per this repo's own
claim-before-work convention — before the label trigger fired, not after.
That makes `claimGithubAnchor`'s assignee POST idempotent on this issue
(GitHub does not emit a second `assigned` timeline event for a no-op
reassignment), so no clean before/after timing exists for the assignee half
of item 1 the way it does for the 👀 reaction. `claimGithubAnchor` posts the
reaction and the assignment as independent best-effort calls, so the
reaction succeeding here says nothing about whether the assignment call
would have; item 1 above proves only the reaction.

A second, separate proof run closed that gap: [#1550](https://github.com/jlapenna/agent-lcars/issues/1550),
created deliberately unassigned (`assignees: []` confirmed at
2026-08-27T16:31:42Z). The `agent:claude` label — the dispatch trigger —
was applied at **16:31:51Z**; the 👀 reaction by `agent-lcars[bot]` landed
at **16:31:56Z** (+5s) and `agent-lcars-bot` was added as assignee at
**16:31:57Z** (+6s). The dispatched run,
[33093692127](https://github.com/jlapenna/agent-lcars/actions/runs/33093692127),
has its lane step "Claim the issue as the agent fleet" at
`conclusion: skipped`, so the assignment provably came from the console's
projection and not from the lane's own claim step (`AGENT_FLEET_LOGIN`
resolves to `agent-lcars-bot`). Together, #1547 proves the reaction half
and #1550 proves the assignee half; a future smoke that wants both from a
single run should leave the throwaway issue unassigned until after the
label triggers the dispatch.

Not directly observed from outside the runner, same as sub-project 1: the
brief's `anchor.html_url`. The run's own `work` log line is direct
confirmation the brief carried a `work` payload derived from the issue.

Residual/known: the park-projection failure (item 4) is **not** a
sub-project 5 regression as such — the oldest stuck outbox entry predates
`cfbb0e77` by six days, and the claim-side projection (item 1-3) works
correctly. It does mean sub-project 5's park projection has never actually
delivered in production for any run, including this one, until #1548 is
fixed. See #1548 for the live incident and root-cause evidence.

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

This smoke proves the **persistence half** (the reaper sweep, checks 1-5
below), and only for the open items this run's API reads actually
returned — not universal coverage; see the pagination note under check 3
below. The **`--resume` half is proven separately, later the same day**,
once the runner image had actually been rebuilt to carry it — see check 6.

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

### 6. `--resume` demonstrably carries context (2026-08-27)

The reaper half above ran before the runner image carrying sub-project 6's
`runner resume` subcommand existed. It was rebuilt later the same day —
`docker-registry.lan.jlapenna.net/homelab-runner:jit-node24` now resolves
to `sha256:e00fd55a54a59e77471d844f941cb0ff4e5985e03d00a304f03ff41e51418908`,
baking this repo's `80795218` — so this check closes the gap the note
above used to leave open, with a full create → park → redispatch-with-
resume → cancel cycle driven end to end through the real API, plus a live
look at the runner containers themselves rather than trusting a log line.

Per the sub-project's own spec, the bar was not "`--resume` appeared on the
command line" — it was the resumed agent **demonstrably remembering**
something from its first turn. The design: one item, redispatched twice,
whose description does not change between runs (redispatch reuses the
item's original spec) but branches on the agent's own conversation
memory — "if you already remember a codeword from earlier in this
conversation, recall it; otherwise generate a new one and state it." A
resumed run's own `lcars session status` line is the check-able,
independently-readable artifact.

`work-create.yml`'s `redispatch` action had no way to pass
`resumeSessionId` through to the API — only the console UI's resume
checkbox did, and using the browser tool to click through a live mutation
is off-limits for verification automation (the `verifying-console-session`
skill's own safety boundary forbids using it to dispatch or mutate live
state). [PR #1567](https://github.com/jlapenna/agent-lcars/pull/1567)
adds an optional `resume_session_id` input, threaded into the POST body
only when non-empty — the same shape sub-project 2's proof used to add the
`redispatch` action itself before it had landed. The resume redispatch
below dispatched from that branch (`--ref docs/1502-resume-live-proof`)
before it merged, exactly as sub-project 2's table above did for
`feat/work-redispatch-action`; every other call in this check used the
unmodified `main` surface.

| Step                                 | Expected                                                                                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| r1 (fresh)                           | parks having generated and stated a codeword                                                                                                                                  |
| Redispatch WITH `resumeSessionId`    | `200`; mints r2, whose run brief carries `resume: {sessionId, transcriptGcsUri}`                                                                                              |
| r2's lane                            | "Resume prior session" succeeds; the archived transcript is fetched and written into Claude Code's own session store; the `claude` CLI is invoked with `--resume <sessionId>` |
| r2 (resumed)                         | parks having **recalled** the exact codeword r1 established, under the same session id                                                                                        |
| Redispatch WITHOUT `resumeSessionId` | `200`; mints r3, whose run brief carries no `resume` field                                                                                                                    |
| r3's lane                            | no `runner resume` process anywhere in the container; `claude` CLI invoked with no `--resume` flag at all; a brand-new session id                                             |
| r3 (fresh)                           | parks having generated a **new, different** codeword — no memory bleed                                                                                                        |
| Cancel                               | `200`                                                                                                                                                                         |

#### Source evidence

| What                                      | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Item                                      | `01M12NS6YH0X441243T0ZJ0DW6` — https://lcars.jlapenna.net/work/01M12NS6YH0X441243T0ZJ0DW6, title "Sub-project 6 resume smoke: codeword continuity"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Create                                    | [work-create run 33123063773](https://github.com/jlapenna/agent-lcars/actions/runs/33123063773): `PUT … -> 201` at 22:34:56.99Z, `runs[0].runId = work:01M12NS6YH0X441243T0ZJ0DW6/r1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| r1                                        | [claude.yml run 33123075734](https://github.com/jlapenna/agent-lcars/actions/runs/33123075734) created 22:34:55Z, conclusion `failure` (parked by design, no PR — deliverable not wanted); session `3bba097e-9659-42ec-8803-36e7902d7bff`, `lcars session status` = **"codeword established: N8FZQ1"**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Item after r1                             | [get run 33123227675](https://github.com/jlapenna/agent-lcars/actions/runs/33123227675): `state: "parked"`, `transcriptGcsUri: gs://agent-lcars-session-transcripts/runs/33123075734/claude-code/3bba097e-9659-42ec-8803-36e7902d7bff.jsonl`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Redispatch WITH resume                    | [redispatch run 33123253581](https://github.com/jlapenna/agent-lcars/actions/runs/33123253581), dispatched `--ref docs/1502-resume-live-proof` with body `{"resumeSessionId":"3bba097e-9659-42ec-8803-36e7902d7bff"}`: `POST …/redispatch -> 200` at 22:37:48Z, `runs[1].runId = work:01M12NS6YH0X441243T0ZJ0DW6/r2`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| r2's lane, caught live                    | [claude.yml run 33123263231](https://github.com/jlapenna/agent-lcars/actions/runs/33123263231); "Resume prior session" step **succeeded**. `docker exec`'d into the runner container while r2 was live (`runner-homelab-autoscale-claude-agent-lcars-a32cf485` on `janeway`, created 22:37:58Z) and observed, in order: the sidecar's own resume process — `node /usr/local/lib/agent-lcars/sidecar.cjs runner resume --session-id 3bba097e-9659-42ec-8803-36e7902d7bff --transcript-uri gs://agent-lcars-session-transcripts/runs/33123075734/claude-code/3bba097e-9659-42ec-8803-36e7902d7bff.jsonl --cwd /home/runner/_work/agent-lcars/agent-lcars`; the file it wrote at the exact path Claude Code reads sessions from — `/home/runner/.claude/projects/-home-runner--work-agent-lcars-agent-lcars/3bba097e-9659-42ec-8803-36e7902d7bff.jsonl` (39 lines, `grep N8FZQ1` matches) — **before** the agent step started; then the live `claude` process itself: `/home/runner/.local/bin/claude --output-format stream-json --verbose --input-format stream-json --max-turns 200 --allowedTools Bash,Edit,Write,MultiEdit --disallowedTools ScheduleWakeup,SendMessage,Monitor,Task --setting-sources=user,project,local --permission-mode default --resume 3bba097e-9659-42ec-8803-36e7902d7bff` |
| r2 (resumed)                              | parked; session id **unchanged** (`3bba097e-…` — Claude Code keeps the same id across a resume), `runId` now `work:01M12NS6YH0X441243T0ZJ0DW6/r2`, `lcars session status` = **"codeword recalled: N8FZQ1"** — the exact codeword r1 established, in a separate dispatch, a different run id, minutes earlier                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Item after r2                             | [get run 33123407701](https://github.com/jlapenna/agent-lcars/actions/runs/33123407701): confirms the above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Redispatch WITHOUT resume (negative case) | [redispatch run 33123443528](https://github.com/jlapenna/agent-lcars/actions/runs/33123443528) on unmodified `main` (no body): `POST …/redispatch -> 200` at 22:40:47Z, `runs[2].runId = work:01M12NS6YH0X441243T0ZJ0DW6/r3`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| r3's lane, caught live                    | [claude.yml run 33123453148](https://github.com/jlapenna/agent-lcars/actions/runs/33123453148); caught the runner container live (`runner-homelab-autoscale-claude-agent-lcars-4328c937` on `spark`, created ~22:40:56Z) — **no** `runner resume` process anywhere (only `runner sidecar`), and the live `claude` process carries **no `--resume` flag at all**: `/home/runner/.local/bin/claude --output-format stream-json --verbose --input-format stream-json --max-turns 200 --allowedTools Bash,Edit,Write,MultiEdit --disallowedTools ScheduleWakeup,SendMessage,Monitor,Task --setting-sources=user,project,local --permission-mode default`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| r3 (fresh)                                | parked; **new** session id `bf82a4a7-065f-4349-957b-2f1df19f89d1` (its own freshly-written transcript on disk, not `3bba097e-…`), `lcars session status` = **"codeword established: K3RVQ8"** — different from `N8FZQ1`, confirming no memory carries over without `resumeSessionId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Item after r3                             | [get run 33123573807](https://github.com/jlapenna/agent-lcars/actions/runs/33123573807): confirms the above; both sessions listed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Cancel                                    | [cancel run 33123610503](https://github.com/jlapenna/agent-lcars/actions/runs/33123610503): `POST …/cancel -> 200`, `state: "canceled"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Create-to-cancel wall clock: 8 min 24 s (22:34:56.99Z → 22:43:20.78Z).

**Result: PASS, on every hop.** The run brief carried `resume`; the lane's
resume step fetched the archived transcript from GCS and wrote it into
Claude Code's real session-store path before the agent step ran;
`--resume <sessionId>` reached the actual CLI invocation, observed live on
the runner rather than inferred from a log line; and the resumed session's
own turn recalled the exact fact — a 6-character codeword neither
guessable nor derivable from the prompt — established in a prior, separate
dispatch under a different run id. The negative case (redispatch without
`resumeSessionId`) independently confirms the mechanism is doing
something real: no resume process in the container, no `--resume` flag on
the CLI, a brand-new session id, and a different codeword.

The `--resume` half of sub-project 6 is proven, not degraded. #1502's
sub-project 6 is complete.
