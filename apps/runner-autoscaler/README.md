# runner-autoscaler

Go source for the GitHub Actions runner-fleet control plane — one
orchestrator process that supervises independent GitHub scale-set listeners
(across `supersprinklesracing/sprinkles` and `jlapenna/agent-lcars`) and
schedules ephemeral runner containers across a shared Docker host pool. Also
includes `runner-image/`, the Dockerfile for the JIT worker image those
runners actually execute jobs in.

This Go module is an Nx application managed by
[`@naxodev/gonx`](https://gonx.naxo.dev/). GoNx infers the standard Go
targets and dependencies from `go.mod`, so local validation, CI, caching,
and affected-project detection all run through the workspace task graph.

## Build & test

```sh
./tools/nx build @agent-lcars/runner-autoscaler
./tools/nx test @agent-lcars/runner-autoscaler
./tools/nx typecheck @agent-lcars/runner-autoscaler
```

The Nx `build` target explicitly passes `-buildvcs=false`. Go 1.26's
automatic VCS stamping can resolve the wrong Git directory from a linked
worktree and fail an otherwise valid build. The autoscaler does not inspect
Go's embedded VCS settings at runtime, and the production Docker build already
copies only the Go sources into its build stage (not `.git`), so it does not
provide those settings either. Keeping the Nx artifact consistent with that
production boundary makes builds deterministic without discarding runtime
metadata that any consumer uses.

## Runner connectivity metrics

The control plane reconciles its locally tracked containers against GitHub's
runner list once per minute per registration. Runners receive a five-minute
startup grace period based on their container creation time; after that,
GitHub-side divergence is exposed as:

- `github_runner_autoscaler_github_unavailable_runners{scale_set,host,reason}`
  where `reason` is bounded to `offline` or `missing`.
- `github_runner_autoscaler_runner_status_probe_up{registration}`, which is
  `0` when the latest GitHub status query failed. Unavailable-runner counts
  retain their last successful values while the probe is down.

The deployment-owned alert can page on unavailable runners persisting for ten
minutes without mistaking the brief registration window during startup for a
dead broker connection.

## Host readiness gate

Reachability is not always enough to decide a host should run CI. A machine
can answer perfectly well while being somewhere, or in some state, you would
rather it not be building — a laptop reachable over a mesh VPN is reachable
from anywhere, including away from home.

A host can therefore be gated on a signal you publish yourself. The
orchestrator holds no opinion about what "ready" means; it reads a gauge and
honors the verdict.

```yaml
fleet:
  placement:
    readiness_metrics_url: http://metrics.internal:9100/metrics
    readiness_metric: host_ci_ready
    readiness_max_age: 5m # optional, strongly recommended
  hosts:
    - name: laptop
      docker: ssh://runner@laptop
      require_readiness: true
```

The endpoint is scraped in Prometheus text format and must serve, for each
gated host, a gauge labelled with that host's name. Greater than zero means
placeable:

```
host_ci_ready{host="laptop"} 1
host_ci_ready_timestamp_seconds 1785702249
```

One endpoint serves the whole fleet rather than one per host, because the
answer is frequently _about_ a host as observed from somewhere else, and the
host itself may be in no position to report it.

The `host` label must be present and match exactly. A series carrying some
other label that merely ends in `host` (`target_host`, `node_host`) does not
count, so a mislabelled signal withholds the host rather than satisfying the
gate.

`readiness_max_age` additionally requires the companion
`<readiness_metric>_timestamp_seconds` gauge to be no older than the given
duration. Setting it is strongly recommended: the gate is **fail-closed**, so
a publisher that dies leaves its last reading served indefinitely, and a stale
`1` would fail the gate _open_ — the single outcome it exists to prevent.

Timestamps materially in the future are rejected too (a couple of minutes of
clock skew is tolerated). Publishing milliseconds where seconds are expected
lands roughly 55,000 years ahead, which would otherwise make the signal
permanently "fresh" and disable the freshness check entirely.

Fail-closed means anything other than a fresh, positive reading withholds the
host: a missing metric, an unreachable or erroring endpoint, a stale or
future-dated timestamp, or a reading for a different host. Hosts without
`require_readiness` are untouched, including when the publisher is broken.

Observability: `github_runner_autoscaler_host_ready{host}` reports the current
verdict per gated host, and exhausting the fleet through the gate increments
`github_runner_autoscaler_placement_blocked_total{reason="readiness"}` rather
than reporting those hosts as unreachable.

## Host load / overload admission

Every placement scores each candidate host's load, CPU utilization, CPU/memory
PSI (pressure-stall) ratios, available memory, and swap-in/out rate against
`fleet.placement` thresholds (`load_soft`/`load_busy`/`load_hard`,
`cpu_soft`/`cpu_hard`, `psi_soft`/`psi_hard`, `memory_soft`/`memory_hard`,
`swap_soft`/`swap_hard`). Crossing a _soft_ threshold only adds a virtual
runner-count penalty, which nudges the round-robin comparison toward less
busy hosts without ruling anything out.

**Swap rate is the exception: it only ever penalizes, never excludes.**
`node_vmstat_pswpin`/`pswpout` are kernel-global counters summed across every
swap device, so they cannot tell zram (compressed RAM, microsecond latency)
from a disk-backed swap file. `pike` runs zram at priority 5 via Ubuntu's
`zram-config` with `vm.swappiness=180`, and treating that healthy compression
traffic as thrashing excluded the fleet's most CPU-idle host from placement
25.1% of a measured week, against 1.7% by memory PSI — which measures the
actual stall instead of a proxy for it. The hard gate therefore belongs to
PSI and available memory; a host genuinely thrashing to disk still stalls,
so PSI still catches it.

Crossing a **hard** threshold on any other single signal is different: the
host is marked hard-overloaded and, once it is, stays that way for
`fleet.placement.overload_cooldown` (default 2 minutes) even after the
underlying signal recovers, so a flapping host doesn't bounce in and out of
rotation. A hard-overloaded (or still-cooling-down) host is **excluded from
the candidate set entirely** rather than merely deprioritized. If that leaves
zero placeable hosts, the placement attempt fails closed to fleet-at-capacity
and leaves demand pending instead of placing on the least-bad overloaded host
— the caller's reconciliation loop is level-triggered and retries once
pressure clears.

This is deliberately different from a host with **no telemetry at all**: a
failed or unconfigured load probe fails _open_, adding only
`fleet.placement.telemetry_penalty` (a small deprioritization, default `1`)
and leaving the host eligible. Confirmed overload (pressure data that says
the host is bad) and absent data are opposite situations, and a telemetry
outage must never be treated as a fleet outage.

Observability:
`github_runner_autoscaler_host_cooldown{host}` is `1` while a host is
hard-overloaded or cooling down;
`github_runner_autoscaler_host_load_penalty{host}` reports its current
virtual penalty; and exhausting the fleet because every reachable,
within-limit host is hard-overloaded or cooling down increments
`github_runner_autoscaler_placement_blocked_total{reason="overload"}`,
distinct from `host_limits` (hosts busy with other work, not pressured) and
from `readiness` (hosts withheld by an operator signal, not their own load).

## Deployment

The actual runtime config (`orchestrator.yml`: fleet host inventory, GitHub
App credentials, scale-set definitions) and the Ansible playbook that deploys
this are owned by [`jlapenna/homelab`](https://github.com/jlapenna/homelab)
(`github-runner-autoscaler/`), which pulls the images this repo's CI builds
and publishes rather than building from source itself — see that repo for
operational docs (secrets, GitHub App setup, fleet topology).

Migrated from `jlapenna/homelab` — see
[agent-lcars#52](https://github.com/jlapenna/agent-lcars/issues/52).

## State checkpointing and restart without a drain

Redeploying used to mean draining the whole fleet first: signal `SIGUSR1`,
then wait for every host to report zero runner containers before recreating
the container. That wait is bounded only by the longest in-flight CI job —
up to `DRAIN_TIMEOUT_SECONDS` (an hour, in the deployment) — and for its
whole duration the control plane refuses every new placement, fleet-wide,
for every repository it serves. A routine deploy could stall all CI for the
length of the slowest job then running.

`SIGTERM` is now a fast **quiesce** instead: refuse new placements, let
in-flight placements settle, write a checkpoint, exit — bounded by
`quiesceTimeout`, comfortably inside Docker's ten-second stop grace, because
overrunning that grace turns an orderly exit into a `SIGKILL` and discards
the checkpoint. `docker compose up --force-recreate` alone is now a safe
deploy; no drain gate is required.

Crucially, quiescing **preserves idle runners** rather than removing them.
Busy runners were already kept for startup adoption; idle ones are warm,
already-registered capacity the replacement process adopts in milliseconds,
and destroying them was pure loss once adoption became reliable.

`SIGUSR1` still performs the full drain, unchanged, for the cases that
genuinely need an empty fleet — removing a scale set, decommissioning a
host.

### What the checkpoint holds, and why

Runner _ownership_ never needed persisting: boot already re-adopts
containers from their Docker labels. What it could not recover is the
**idle/busy split**. Adoption used to re-derive it by inspecting each
container for a `Runner.Worker` process, which can only report whether that
process exists _yet_ — so a runner GitHub had already assigned a job to, but
which was still pulling its image or checking out, was adopted as **idle**,
and anything reaping idle capacity would then kill a live job. That single
misclassification is why a restart had to be preceded by a drain.

The checkpoint records the split this process actually observed from
GitHub's `JobStarted`/`JobCompleted` messages, so adoption restores what was
known instead of guessing. It also carries host overload cooldowns (which
otherwise reset, making a host that was hard-overloaded seconds ago
immediately placeable again) and the previous host telemetry samples
(without which the first probe after boot computes every rate as zero,
disabling pressure-based admission until a second sample lands).

Runner transitions checkpoint synchronously — a transition lost to a kill is
exactly the misclassification being prevented. The fleet-telemetry half
flushes on a timer.

At boot the checkpoint is authoritative for classification; Docker remains
authoritative for existence. A container the checkpoint does not mention
falls back to the process probe, so a first boot, a corrupt file, or a
newly added scale set all still work.

### Boot sweep and unreachable hosts

The boot sweep that performs adoption runs one goroutine per fleet host, and
gates each on a short reachability probe. Both matter for how quickly the
control plane becomes useful again, because every scale set runs its own
sweep before its listener connects: swept serially, one wedged host delayed
every host behind it, and every scale set paid that delay independently.

An unreachable host is skipped with a log line rather than waited on. Its
containers are simply not adopted on that pass — already what happened when
the list call itself failed — and the periodic sweeper picks them up once the
host returns.

Note that a host being unreachable is not the same as it being slow to
answer. SSH's `ConnectTimeout` bounds only the TCP connect, so a host that
accepts the connection and then never completes its banner exchange is not
covered by it; the per-host calls carry their own deadlines for that case.

### Configuration

`server.state_path` is **required**, and required to be an absolute path in
a writable directory:

```yaml
server:
  state_path: /var/lib/runner-autoscaler/state.json
```

The process refuses to start without one, and `--check-config` fails the
same way, so a missing or unwritable state volume is caught by the deploy's
preflight rather than after cutover. This is deliberately loud: a restart is
only safe when the state actually persists, and silently degrading to the
guess would reintroduce precisely the hazard the checkpoint removes.

The path must be backed by a volume that survives container recreation. A
path inside the container's own filesystem is erased by the very restart the
checkpoint exists to make safe. The image creates
`/var/lib/runner-autoscaler` owned by the runtime uid so a named volume
mounted there inherits writable ownership.

## Live configuration reload

Send the running orchestrator `SIGHUP` after atomically replacing
`orchestrator.yml`. It validates the replacement configuration and
credentials before changing anything, then reconnects listeners and adopts
the existing runner containers; busy jobs and idle capacity are not drained.
Invalid files leave the current configuration running.

Live reload can update scale-set limits, images, resource settings, placement
policy, weights, credentials, scale sets, and fleet hosts. Added hosts are
immediately eligible for placements. Removed hosts are cordoned immediately,
while their tracked runners remain managed until their jobs complete (and are
dropped on the next reload). The metrics bind address, `server.state_path`,
and an existing scale set's GitHub registration/runner group are
process-lifetime settings; removing a scale set remains a drain-and-restart
operation. Renaming a host is required when its Docker transport changes.

`server.state_path` is process-lifetime because the checkpoint store binds
its path at startup. Accepting a change would send every later checkpoint to
the _old_ file while the configuration claimed otherwise, and a subsequent
restart would then adopt from a path nothing had written since the reload.
A reload that moves it is rejected outright, leaving the current
configuration running.
