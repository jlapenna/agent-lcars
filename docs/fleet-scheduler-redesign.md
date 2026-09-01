# Fleet scheduler redesign

Design proposal for `apps/runner-autoscaler`, written 2026-09-01 after four
reachable hosts with roughly 92 GiB of RAM ran two `homelab-autoscale-default`
runners for most of a working day (homelab#1067, #1068, #1077). Tracking
issue: agent-lcars#1685. Rendered version with the capacity diagram:
<https://claude.ai/code/artifact/bd5be193-0a2f-468e-aa1e-9a60d18463db>.

## Thesis

1. **The scheduler reserves what a job could use, not what jobs do use.** One
   number, `runner_memory`, was both the OOM ceiling and the bin-packing
   reservation. The ceiling is sized for the 0.2% job; charging it for every
   placement idles most of the fleet.
2. **One lane carries jobs that differ by a factor of a hundred.** The default
   lane's median runner peaks at 137 MB; its p90 at 7.7 GB. Every 137 MB glue
   job pays for a 14 GiB slot.
3. **Nothing degrades gracefully and nothing names its cause.** Losing two
   hosts turned a degraded fleet into a stalled one, and three unrelated
   failures ran for hours under alerts that were already firing for other
   reasons.

## What the fleet looked like at 18:37Z

All four hosts were reachable and none was under memory or I/O pressure. The
default lane wanted three runners and held two. Every rejection in the
autoscaler log was the same sentence:

```
failed to pick a placement host: no reachable docker host can admit candidate
memory reservation 15032385536 bytes (laforge: reserved=15032385536 budget=29561226854;
janeway: reserved=2147483648 budget=14479183872; laptop: reserved=15032385536 budget=29692812902)
```

| Host    | Physical | Free at 18:40Z | Why the default lane was refused                                                |
| ------- | -------: | -------------: | ------------------------------------------------------------------------------- |
| laforge | 30.6 GiB |          24 GB | holds one 14 GiB reservation; a second exceeds the 29.5 GiB budget by 0.5 GiB   |
| laptop  | 30.7 GiB |          28 GB | same arithmetic                                                                 |
| janeway |   16 GiB |          13 GB | 13.5 GiB budget can never hold a 14 GiB reservation                             |
| homelab |   16 GiB |           7 GB | `runner_limit: 1` counts every lane; the always-warm control runner occupies it |

### What runners actually use

Thirty days of cAdvisor data for the default lane, 6,573 runners:

| Percentile             | RSS peak | max_usage (incl. page cache) |
| ---------------------- | -------: | ---------------------------: |
| p50                    |        — |                       137 MB |
| p90                    |  2.5 GiB |                      7.7 GiB |
| p95                    |  7.2 GiB |                     10.4 GiB |
| p99                    |  9.6 GiB |         14 GiB (the ceiling) |
| max                    | 13.3 GiB |                       14 GiB |
| runs with RSS > 12 GiB |        2 |                            — |
| OOM kills              |        0 |                            — |

The 14 GiB ceiling is right: it exists so the two-in-six-thousand job cannot
swap out its co-tenants. Using that same figure as every runner's footprint is
the mistake. Half the lane's runners never exceed the memory of a browser tab.

## Why the current design fails

1. **Reservation equals ceiling** (agent-lcars#1429). Correct for safety, wrong
   for packing. Fixed structurally by #1684 (`runner_memory_reservation`);
   homelab#1079 sets the default lane to 8 GiB.
2. **Lanes are sized by their worst job.** The default lane serves the
   sprinkles `Full verification` build and a five-minute reporting job with
   the same 14 GiB slot. Sprinkles moved its control jobs to a 2 GiB lane on
   2026-09-01; its CI and deploy matrix has not been tiered.
3. **No feedback from reality.** The scheduler never looks at a running
   runner's usage, only its declared reservation, and never at a host's actual
   free memory, only the budget minus declared reservations. It cannot notice
   that laforge has 24 GB free.
4. **No degradation ladder.** When no host admits the declared reservation the
   answer is "no host has placement capacity right now", forever. A fleet that
   lost two of six hosts should shrink, not stop.
5. **Count caps double-count.** `runner_limit: 1` on homelab protects a 16 GiB
   host from two heavy runners, but it also forbids a 2 GiB control runner and
   a 6 GiB glue runner from coexisting, which memory admission already governs.
6. **Consumers pin implementation details.** Workflows hardcoded `oldbook` for
   BuildKit (sprinkles#5053); homelab#1005 retired pools the same morning #997
   routed jobs onto them (homelab#1070). No contract test exists on either side.
7. **Failures are silent or drowned.** A controller timer exited 1 every three
   minutes for three hours with nothing in its journal (homelab#1074); the
   reconciler-failing alert was reset by lock-bail cycles; twenty-five alerts
   were already firing, several for days.

## Design principles

- **Reserve the measured footprint, cap at the pathological one.** Requests and
  limits are different numbers with different jobs.
- **Route by footprint, not by repository.** A lane is a memory tier and a
  privilege posture. A repository uses several.
- **Every refusal is a metric with a reason and a host.** Nothing that blocks
  placement lives only in a log line.
- **Degrade in steps, never to zero.** Losing hosts reduces slots
  proportionally; policy never removes the last slot on a reachable,
  unpressured host.
- **Contracts on both sides of every label and every hostname.** A consumer
  cannot target what the fleet does not declare, and the fleet cannot retire
  what a consumer targets.

## Proposal

### A. Requests versus limits (landed)

`runner_memory_reservation` is charged for admission and in-flight
accounting; `runner_memory` stays the cgroup ceiling. Homelab's default lane
sets the reservation to 8 GiB (above p95 RSS, below p99) and keeps the 14 GiB
ceiling.

| Lane / host                                       | laforge | laptop | janeway | homelab | total |
| ------------------------------------------------- | ------: | -----: | ------: | ------: | ----: |
| default before (14 GiB reserved)                  |       1 |      1 |       0 |       0 |     2 |
| default with 8 GiB reservation                    |       3 |      3 |       1 |       0 |     7 |
| + homelab `runner_limit: 2` and a 6 GiB glue tier |       3 |      3 |       1 |       1 |     8 |

Three co-tenants at 8 GiB each on a 30 GiB host can, in principle, all spike
toward their 14 GiB ceilings at once, and placement gates only affect the
_next_ placement; nothing today bounds runners already admitted. Two things
close that gap, and the second is a precondition for any overcommit above
1.0 (agent-lcars#1700):

- **A host-level runner slice.** Every runner container starts under a
  dedicated cgroup parent whose `memory.max` is the host's reservation budget
  and whose `memory.high` sits just below it, so co-tenants are bounded
  collectively and reclaim or an OOM kill stays inside the runner slice rather
  than reaching the control plane, registry, or exporters on that host.
- **A correlated measurement.** Per-run p99 treated as independent is the
  wrong statistic for a build matrix that fans out together. With the
  runner-to-job gauge (#1698) and cAdvisor, measure the p99 of the _sum_ of
  co-tenant RSS per host over two weeks; the 8 GiB reservation stays, and
  overcommit stays at 1.0, until that sum shows headroom under the slice bound.

With those in place the trade is the one Kubernetes makes with requests below
limits, and it is the right one here.

### B. Memory tiers instead of one default lane

Split the sprinkles default lane the way its jobs already split: a **light**
tier (2 GiB ceiling, 1 GiB reservation) for tests, lint, reporting and deploy
glue, and a **heavy** tier (14 GiB ceiling, 8 GiB reservation) for full builds
and E2E. Routing is a `runs-on` label per job. Light jobs stop waiting behind
builds, and a 30 GiB host holds 20 of them.

The measurement to make first: peak memory per _job name_, not per runner.
Container labels are fixed at creation, before GitHub assigns a job, and the
Actions exporter deliberately carries no runner names, so the shared key is a
metric the autoscaler publishes at `JobStarted` (#1698):
`github_runner_autoscaler_runner_job_info{runner,job_id,job_name,workflow,repository}`,
where `runner` is the container name and therefore cAdvisor's `name` label.
Peak memory per job name over a week is then one PromQL join
(documented in `apps/runner-autoscaler/README.md`, "Measuring per-job
memory"); the series is removed on completion, so cardinality is bounded by
concurrent busy runners.

### C. Usage-aware admission and a bounded overcommit

Two additions to `pickHostLocked`, both behind config and both exported:

1. **Charge the larger of reservation and observed usage** for running
   runners, sampled from the container's cgroup at placement time. A runner
   that blew past its reservation counts for what it is using; one under it
   still counts for its reservation. This makes reservations safe to set low.
2. **Overcommit factor per host** (`memory_overcommit: 1.0` default, 1.25 for
   the 30 GiB hosts), applied to the budget only while the host's
   `MemAvailable` and memory PSI are inside the soft thresholds. The pressure
   gates already exist; this lets them do their job instead of a static
   number doing it badly.

### D. A degradation ladder with a floor

When no host admits a lane's reservation, replace the hard error with an
ordered ladder, each rung logged and counted under its own
`placement_degraded_total{rung}`:

1. Admit at the declared reservation (normal).
2. Admit at the observed p95 for that lane over the last 7 days, if a host has
   that much free budget and is not soft-pressured.
3. Admit one runner on the least-loaded reachable host if its real free memory
   (`MemAvailable`) exceeds the lane's ceiling, regardless of reservations, at
   most one such runner per host at a time.
4. Refuse, and set `github_runner_autoscaler_lane_admissible_hosts{scale_set}`
   to 0 so the alert names it.

Rung 3 is the invariant that a reachable, idle host with more free memory than
the job's ceiling always runs the job. It is exactly what a human would have
done on laforge on 2026-09-01.

### E. Capacity as a first-class metric

- `lane_admissible_slots{scale_set}`: how many more runners each lane could
  place right now, computed from the same admission code, not re-derived in
  PromQL.
- `placement_blocked_total{scale_set,host,reason}` gains the host label so
  "which constraint binds where" is a panel, not a grep.
- `scale_set_info{scale_set,registration,owner,repository}` (in #1684) joins
  queue depth to the lanes declared for a repository. Once a repository has
  two lanes that join is ambiguous, so the exporter gains the job's `runs-on`
  as a bounded `runs_on` label and the autoscaler publishes one
  `scale_set_label_info{scale_set,label}` series per declared label; the
  unserved-queue rule then matches lane to lane (agent-lcars#1699).
- Alerts on cause, not symptom: `RunnerLaneNoAdmissibleHost`,
  `RunnerLaneUnservedQueue`, `DeliveryReconcilerCrashLooping`,
  `GitHubActionsMainWorkflowFailing` (homelab#1077, #1078).

### F. Host roles and the fleet invariant

Declare each host's role explicitly: `permanent`, `opportunistic` (laptop),
`maintenance` (pike). The scheduler computes admissible slots per lane over
permanent hosts only and alerts when any lane with a consumer drops below a
configured minimum, before the queue notices. Maintenance hosts keep their
credentials revoked and their re-entry preflight, as today.

### G. Contracts on labels and hostnames

- **Label contract, fleet side:** a CI check in homelab that reads every member
  repository's workflows through the fleet App and fails a change that retires
  a scale set some workflow still targets. The runtime backstop is
  `RunnerLaneUnservedQueue`.
- **Label contract, consumer side:** the published `repo-validation` workflow
  asserts each fleet-style `runs-on` value appears in a small labels manifest
  the fleet publishes.
- **Role names, not hosts:** `buildkit.lan.jlapenna.net` as a CNAME with the
  alias in the server certificate's SAN, so builder failover is one DNS change
  instead of four pull requests across repositories.
- **Retirement protocol:** a pool may be removed only after the exporter shows
  zero jobs on its labels for seven days. That is a query, so it can be a
  check.

### H. No silent controllers

- Every controller timer exports a windowed failure count from its journal
  (landed for image delivery in homelab#1078); a lock-bail exits with a
  distinct status (75, `EX_TEMPFAIL`) so "skipped" and "succeeded" stop
  sharing a code.
- A shell lint in both repositories rejects a bare `return` after `||` under
  `set -e`, the exact shape of homelab#1074.
- Control-plane work (reconcile, deploy) never runs on a lane a drain can
  empty (homelab#1056 fixed the deadlock; this makes it policy).
- The fleet reconciler skips hosts already known unreachable instead of
  re-timing-out on SSH every pass: on 2026-09-01 it held the deployment lock
  for roughly ten of every fifteen minutes while timing out against spark and
  oldbook, so merge-to-live got about one real cycle in three.

## Phasing

| Phase   | Scope                                                                                                                                                                                                  | Status    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| phase 0 | #1684; homelab `runner_memory_reservation: 8g` (#1079); cause-naming alerts (#1078)                                                                                                                    | in flight |
| phase 1 | Stamp job ids on runner containers; measure peak memory per job name for a week; split sprinkles into light and heavy tiers; fleet-side label contract check; BuildKit alias; reconciler host skipping | proposed  |
| phase 2 | Usage-aware charging and per-host overcommit (C); `lane_admissible_slots` and host-labelled block reasons (E); host roles and the fleet invariant alert (F)                                            | proposed  |
| phase 3 | Degradation ladder (D) with its floor invariant, behind a config flag, canaried on the heavy tier first                                                                                                | proposed  |

## Decisions (approved 2026-09-01)

The maintainer approved the proposal with its recommended defaults:

- **Default-lane reservation: 8 GiB** (live since homelab#1079). Revisit only
  with a fresh per-job measurement; 10 GiB stays the documented fallback if
  co-tenant pressure ever shows up in the PSI gates.
- **Overcommit: 1.25 on the 30 GiB hosts** (laforge, laptop), 1.0 elsewhere,
  applied only while `MemAvailable` and memory PSI sit inside the soft
  thresholds (phase 2).
- **homelab (the control host) hosts only light and control tiers**, never a
  heavy runner; its `runner_limit` rises to 2 only alongside a light tier.
- **Tier names: `ci-light` and `ci-heavy`** for the sprinkles split; `control`
  keeps its narrow meaning (control-plane glue), `default` is retired once
  every consumer has moved.

Implementation issues are tracked as sub-items of agent-lcars#1685, one per
phase item.

The expected result of phase 0 alone, with the same four hosts: seven default
slots instead of two, and an alert that says "no host can admit this lane" the
next time policy, not hardware, is the reason.
