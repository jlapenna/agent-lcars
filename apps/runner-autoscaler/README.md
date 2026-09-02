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

`go.mod`'s `github.com/actions/scaleset` dependency is pinned to a
pseudo-version off upstream's `main` branch rather than its latest tag,
because upstream's tags lag `main` by an unpredictable margin (agent-lcars#1716
found our existing pin already _was_ `main`'s head commit while the newest
tag predated it). `.github/workflows/scaleset-upstream.yml` runs weekly to
propose the next bump as a PR once `main` actually advances.

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

## Scale-set listener statistics

Each scale set's listener session implements `listener.MetricsRecorder`
(`scale_set_stats_recorder.go`) and exports the full
`RunnerScaleSetStatistic` GitHub sends it, rather than discarding everything
but the assigned-job count the scaler already consumes:

- `github_runner_autoscaler_scale_set_stats{scale_set,field}` -- one gauge
  per statistic, updated on every `RecordStatistics` call (the initial
  session and every subsequent polled message). `field` is one of
  `available_jobs`, `acquired_jobs`, `assigned_jobs`, `running_jobs`,
  `registered_runners`, `busy_runners`, `idle_runners`.
- `github_runner_autoscaler_scale_set_last_message_timestamp_seconds{scale_set}`
  -- unix time the listener last processed an actual message from GitHub.
  Set from `RecordStatistics` only when the statistics arrived attached to a
  polled message (not the one-time initial-session statistics), and
  independently from `RecordJobStarted`/`RecordJobCompleted`, which fire
  only for real messages.
- `github_runner_autoscaler_scale_set_session_started_timestamp_seconds{scale_set}`
  -- unix time the current listener session was (re)created. A session can
  restart (and this timestamp jump forward) with no new message ever
  following it; that gap between the two timestamps is the signal a
  healthy-looking listener can still be silently starved.

`github_runner_autoscaler_desired_runners` continues to be set only by
`Scaler.HandleDesiredRunnerCount`, not by this recorder's
`RecordDesiredRunners` hook -- the scaler's target-runner-count computation
and the value this hook receives are not always bit-identical, and setting
the same series from both places would race them against each other.

**Stranded-queue signature (agent-lcars#1716):** a scale set is stuck when
the GitHub Actions exporter shows `queued > 0` for the `runs_on` label this
scale set serves (join via `github_runner_autoscaler_scale_set_label_info`)
while this scale set's own `available_jobs + acquired_jobs + assigned_jobs +
running_jobs == 0` and `github_runner_autoscaler_desired_runners == 0` --
i.e. GitHub is not offering this scale set any of the work the exporter says
is queued for its label, so nothing here can even try to scale up. That is
the exact incident #1716 documents (GitHub stopped routing an ephemeral
runner's follow-up job to the scale set that should have served it) and is
what the homelab `RunnerLaneStrandedQueue` alert rule watches for. This
recorder also logs once at INFO, cheaply and independently of that alert,
whenever `available_jobs > 0` persists for two consecutive polls while
`desired_runners == 0` -- jobs are being offered but never turning into
runner demand.

**Broker HTTP/2 keepalive probing (`scaleset_http_client.go`):** the
listener session's long poll to `broker.actions.githubusercontent.com` blocks
for up to ~50s server-side, and `actions/scaleset#105` (tracking
`actions-runner-controller#3682`) documents a proven failure mode against
that broker where an HTTP/2 connection goes dead -- no RST, no FIN, the OS
never notices -- and every call that reuses it then hangs for 15-20 minutes
before recovering, which looks exactly like the silently-starved listener
this section's own stranded-queue signature exists to catch.
`Config.ScalesetClient` therefore injects a `retryablehttp.Client` (via the
library's `scaleset.WithRetryableHTTPClint`) whose transport has HTTP/2
keepalive PINGs configured (`ReadIdleTimeout` 30s, `PingTimeout` 15s) and an
overall per-request timeout of 90s -- comfortably above the broker's poll
window, comfortably below the multi-minute hangs a dead connection otherwise
causes.

## LCARS live runner status

The autoscaler can publish its current queue depth and each scale set's
idle/busy runners to the LCARS console. It writes one bounded document per
scale set to the existing `agent-telemetry` Firestore database; the console
already has read-only access there. This keeps the console out of the runner
placement path and does not grant it a new writer role.

Publishing is deliberately opt-in and fail-soft. Set these only in the
homelab autoscaler deployment, with the existing telemetry-writer credential
mounted as `GOOGLE_APPLICATION_CREDENTIALS`:

```sh
AGENT_LCARS_AUTOSCALER_STATUS_ENABLED=true
AGENT_TELEMETRY_PROJECT_ID=agent-lcars
AGENT_TELEMETRY_DATABASE_ID=(default)
GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/telemetry-writer.json
```

The credential stays in the encrypted homelab secret store. A missing or
temporarily unavailable credential logs a warning and never blocks a GitHub
listener, runner placement, or cleanup. Snapshots publish immediately on
startup and then every 10 seconds; the console stops presenting a snapshot as
live after 30 seconds without an update.

The same bounded `runner-status` collection also contains one reserved
`queue-executor` document (`schemaVersion: 2`, `kind: "queue-executor"`) for
the direct executor. It reports only generic worker health: readiness,
draining, configured direct-container capacity, and an active-container count
when every Docker host can be read. It has no pipeline, repository, provider,
credential, or individual-run data. Queue lifecycle counts (queued, claimed,
running, and outcomes) remain the Console's authoritative orchestrator Run
records, not autoscaler telemetry. Older console readers ignore this distinct
v2 document safely while continuing to consume v1 scale-set snapshots.

## Queue executor (direct-mode runners)

Server-dispatched work: an additional goroutine
that polls the console's `POST
/api/work/v1/runs/claim` and, on a successful claim, launches one direct-mode
runner container -- entirely outside the GitHub scale-set state machine
above (not GitHub-registered, not tracked by any `Scaler`, one-shot). The
Console routes every admitted run through this one
server-authoritative executor; the run's pipeline selects only its provider
adapter after the queue has claimed it. Its autoscaler configuration is:

```sh
LCARS_CONSOLE_URL=https://lcars.jlapenna.net
LCARS_WORK_AUDIENCE=agent-lcars-work
GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/telemetry-writer.json
LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH=/secrets/telemetry-writer.json
LCARS_QUEUE_CLAUDE_TOKEN_HOST_PATH=/secrets/claude-code-oauth-token
LCARS_QUEUE_OPENCODE_KEY_HOST_PATH=/secrets/opencode-llm-api-key
LCARS_QUEUE_MAX_CONCURRENT=1
```

With those durable console and credential settings present, daemon startup
also runs a disposable Docker bind-read probe on every configured host. Only
hosts that can read the telemetry, Claude, and OpenCode mount files enter the
direct queue's launch pool; unavailable laptops and other failed probes remain
outside that pool. The poller starts only when at least one eligible host
passes, then sends a claim body containing only its runner identity.
The server derives claimable pipelines from the authenticated `work.executor`
grant; no autoscaler-local pipeline allowlist exists.

### Native schedule ticker

The same continuously running process ticks native schedules through
`POST /api/work/v1/schedules/tick` once at startup and then every five
minutes. It reuses the queue executor's Google ID-token source and Work API
audience, but needs the separate `work.cron` scope; `work.executor` alone
cannot mint schedules, and `work.cron` cannot claim runs. This keeps schedule
state and admission in the Work API and removes GitHub Actions schedule
delivery from the ingress path. `github_runner_autoscaler_schedule_ticks_total`
reports `success` and `error` outcomes for operations monitoring.

Every healthy autoscaler replica performs this tick; there is deliberately no
host leader election. The Work API derives one deterministic item/request id
per `(scheduleId, due slot)` and the orchestrator persists it with
compare-and-set, so simultaneous ticks coalesce to one durable item and run.

Provider credentials stay behind the direct-runner adapter boundary: Claude
and OpenCode receive their respective host-staged token files as read-only
mounts, never Docker environment values; Codex receives no host credential and
uses the run-token-authenticated Console broker for its repository auth.json.
`LCARS_QUEUE_OPENCODE_KEY_HOST_PATH` must contain the LiteLLM virtual key
(`OPENCODE_LLM_API_KEY`) before OpenCode work can launch. The direct adapter
uses the baked, trusted `/usr/local/bin/opencode run` entry point, not its
GitHub Actions-only `github run` integration. It defaults `OPENCODE_MODEL`
to `homelab/default-nothink`; the model may be overridden only in the
autoscaler's process environment. The baked OpenCode config consumes the
read-only key file directly, rather than exporting the key to the OpenCode
process, so routine agent tool-shell environment inspection cannot recover it.

The console claim call is authenticated with a Google ID token minted
directly from the telemetry-writer service-account key (self-signed, no
metadata server, no new IAM grant -- this fleet does not run on GCE/Cloud
Run), for the audience `LCARS_WORK_AUDIENCE` names (default
`agent-lcars-work`, the same default the console's own
`AGENT_LCARS_WORK_AUDIENCE` falls back to -- see `docs/deployment-
boundary.md`'s work-grants table). Set both sides together if either ever
changes; a mismatch fails every claim with 401, not a helpful error naming
the audience.

**None of this reloads on `SIGHUP`.** Every `LCARS_QUEUE_*`/
`LCARS_CONSOLE_URL`/`LCARS_WORK_AUDIENCE` value above, and the Docker hosts
pool `launchDirectRunner` places containers on, is read once at process
startup inside `runOrchestrator` and closed over by the poller goroutine for
its whole lifetime -- unlike scale-set limits, images, and fleet hosts
(see "Live configuration reload" below), a live config reload never touches
the queue executor at all, whether or not it changed anything queue-related.
Changing any of them, or turning the queue executor on or off, needs a full
daemon restart, not a config-file replace-and-`SIGHUP`.

`LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH` is the telemetry-writer key's path
**on the Docker host**, not this process's own
`GOOGLE_APPLICATION_CREDENTIALS` path: a claimed run's container is
bind-mounted this file (read-only, at `/run/secrets/telemetry-writer.json`,
the fixed path `direct-runner.sh` reads) by the Docker daemon that actually
creates it, which may be a remote fleet host over SSH -- so it cannot be
inferred from a path meaningful only inside the autoscaler's own container.
Required for queue-executor startup; a claim that cannot resolve it fails
loudly rather than guessing.

`LCARS_QUEUE_MAX_CONCURRENT` (default `1`) caps how many direct-mode
containers may run concurrently on any one host. Placement itself is
round-robin over the same `--docker-hosts` pool used for GitHub-mode
runners -- deliberately not `Scaler`'s load-aware host scoring, a stated
simplification for this first cut.

### Readiness and claim outcomes

The metrics endpoint exposes the queue worker independently of the GitHub
scale-set listeners:

- `github_runner_autoscaler_queue_executor_ready` is `1` only after the
  queue executor has all required deployment configuration, a claim-token
  source, and at least one host that passed the permanent credential-mount
  probe; it is `0` when disabled or misconfigured.
- `github_runner_autoscaler_queue_executor_state{state}` is a one-hot state
  (`disabled`, `misconfigured`, or `ready`). An absent `LCARS_CONSOLE_URL`
  is disabled; a console URL with a missing required credential or host-path
  setting is misconfigured.
- `github_runner_autoscaler_queue_executor_polls_total{outcome}` separates a
  healthy empty queue (`idle_204` or `idle_empty`) from `poll_error` and the
  intentional `draining` skip.
- `github_runner_autoscaler_queue_executor_claims_total` counts valid claims
  returned by the server. `github_runner_autoscaler_queue_executor_launches_total{outcome}`
  then records whether that claim launched a direct runner (`success` or
  `error`). A launch error therefore remains visible as a successful claim
  followed by a failed launch, rather than looking like an idle poll.

### Exited direct-runner retention

Direct-mode containers use `AutoRemove: false` so their exit logs remain
available for diagnosis. The queue worker now starts a label-scoped sweep on
startup and every 15 minutes. Sweeps run separately from claim polling, are
single-flight, and have a 30-second whole-sweep deadline, so a slow Docker
host or a historical backlog cannot delay a work claim. It considers only
containers whose
`agent-lcars.direct-runner=1` **and**
`agent-lcars.direct-runner.run-id` labels were set by this launcher, and only
after Docker reports them `exited`. It never lists or removes GitHub Actions
runner containers, other application containers, or running direct runners.

Per Docker host, the five most recent exited direct runners are retained for
up to 24 hours; any older exit or any exit beyond those five is removed. Both
the ordering and age use Docker's inspected `State.FinishedAt`, not the
container creation time, so a long-running runner receives the same evidence
window as a short-lived failure. This keeps enough recent failure logs for
investigation while bounding retained containers even during a failure burst.
Removal is non-forcing: if a container races back to running, Docker refuses
the deletion rather than ending an active run.

**A failed launch leaves the run claimed on the control plane.** There is no
callback here to un-claim it -- by design, see the design spec's "Autoscaler
change". Recovery is passive, and mints a NEW run rather than reusing the
dead one: the failure is logged and the poller moves on; the claim's lease
eventually expires (`LEASE_MS`, 2h), the dead run settles to `lost` --
its `queue.state` stays `claimed` forever, nothing ever moves it back to
`queued` -- and the orchestrator's bounded auto-retry (`MAX_AUTO_RETRIES`,
then parked) mints a fresh `queue`-executor run for the same task, which a
later poll (from this host or another) claims instead. A launch failure
therefore costs roughly one lease window of latency, not a stuck run, but
it is not instantaneous, and it is not the same run id claimed again --
don't expect a retry within the poll interval.

**A global drain (`SIGUSR1`) also stops the queue poller from claiming.**
The same signal that calls `BeginDrain` on every GitHub-mode `Scaler` also
flips an in-process flag the poller checks before every claim call, cleared
again on `EndDrain`/self-heal -- a claim minted moments before this instance
is replaced would just be another launch failure to recover from, so the
drain skips it instead. This is a separate, in-memory switch from the
`queue.state` machine above: it has no effect on runs already claimed, and
nothing else in this repo (a redeploy that never signals `SIGUSR1`, a plain
restart) touches it.

### Delivering the claude CLI's own credential

`launchDirectRunnerOnHost` (`queue_executor.go`) sets `RUNNER_MODE`,
`LCARS_RUN_ID`, `LCARS_RUN_TOKEN`, and optionally `LCARS_CONSOLE_URL` on the
direct-mode container's `Config.Env`, plus two read-only file bind-mounts:
`telemetry-writer.json` (above) and, at the fixed in-container path
`/run/secrets/claude-code-oauth-token`, a plain-text file holding the
current `CLAUDE_CODE_OAUTH_TOKEN` value -- the `claude` CLI's own
subscription credential (in GitHub Actions mode this is reachable via
GitHub-Actions-WIF impersonation of
`claude-token-reader@agent-lcars.iam.gserviceaccount.com`, which a homelab
Docker container cannot do; there is no other delivery path). `direct-runner.sh`
reads that file and exports it as `CLAUDE_CODE_OAUTH_TOKEN` into its own
process environment immediately before invoking `claude` (`claude` reads it
straight from its process environment; no flag or file path is accepted
directly). This is deliberately a file mount, not a third `Config.Env`
entry: a `Config.Env` value set at `ContainerCreate` time is visible to
anything that can `docker inspect` the container on that host, while a file
this script reads and exports at runtime is not.

`LCARS_QUEUE_CLAUDE_TOKEN_HOST_PATH` is that file's path **on the Docker
host** -- the same "cannot be inferred, so it is required and fails loudly"
reasoning as `LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH` immediately above,
and it is required only when the executor grant permits `claude`; a
Codex-only executor neither resolves nor mounts this file.

**Placing the secret's value on the Docker host is still a one-time,
maintainer-gated action this repo's own code cannot perform**: a maintainer
copies the current `CLAUDE_CODE_OAUTH_TOKEN` secret value into the homelab
encrypted secret store (`secrets-cli` skill) and stages it as a file at
whatever path `LCARS_QUEUE_CLAUDE_TOKEN_HOST_PATH` names, mode `0600`, same
as `telemetry-writer.json`. Not a Terraform change, not a new IAM grant, and
not something any workflow in this repo performs -- but the bind mount and
the in-container read-and-export it feeds are wired code. See
`docs/deployment-boundary.md`'s "Queue executor routing" section for the
ownership boundary.

### Delivering Codex subscription authentication

Codex direct mode receives no host-mounted subscription credential and no
GCS-capable key. A live run token fetches repository-scoped `auth.json` from
the console's Codex-auth broker and later writes a rotated credential back only
with the exact restored GCS generation. The broker rejects known burned
refresh lineages and treats a generation conflict as terminal, so a stale
runner cannot overwrite a newer rotation.

Codex session files remain only in the runner's volatile filesystem until the
telemetry sidecar has finalized and archived them; cleanup then removes the
per-run directory. A retained Docker container therefore holds neither the
subscription credential nor its session transcript.

Direct Codex requires the separately reviewed,
repository-prefix-preserving runtime grant on `agent-lcars-codex-auth` and a
single-run canary before activation. This repository does not make that IAM
change; queue readiness does not bypass the broker's lease and repository
authorization checks.

## Host telemetry timeout

Host telemetry probes use a one-second deadline by default. A host with a
legitimately slow node-exporter collector can opt into a longer, scoped
deadline without delaying probes for the rest of the fleet:

```yaml
fleet:
  hosts:
    - name: pike
      docker: ssh://runner@pike
      metrics_timeout: 5s
```

`metrics_timeout` must be a positive Go duration. The same deadline applies
to HTTP and SSH telemetry probes; a failed probe still preserves the
placement gate's existing fail-open behavior.

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
verdict per gated host, and each host the gate withholds increments
`github_runner_autoscaler_placement_blocked_total{host,reason="readiness"}`
rather than reporting that host as unreachable.

## Aggregate reserved-memory admission

`runner_memory` is the Docker cgroup limit for one runner and, unless
`runner_memory_reservation` is declared, also its scheduler reservation.
Before placing a memory-bounded runner, the scheduler
sums the declared reservations of every running autoscaled runner on that host
plus starts currently in flight, then checks the candidate against the host's
physical memory as reported by Docker. A configurable safety-margin fraction
is kept outside that budget:

```yaml
fleet:
  placement:
    memory_safety_margin: 0.10 # default: reserve ten percent for the host

scale_sets:
  - name: e2e
    runner_memory: 12g
  - name: default
    runner_memory: 14g # cgroup ceiling: protects co-tenants
    runner_memory_reservation: 8g # what placement charges against the host
```

`runner_memory_reservation` (agent-lcars#1683) separates the two concerns the
way Kubernetes separates requests from limits. The ceiling bounds the rare
pathological job; the reservation is the measured footprint used for
bin-packing, so a fleet does not shrink to a fraction of its RAM the moment a
host drops out. It requires `runner_memory`, must not exceed it, and defaults
to it when omitted. The per-lane values are exported as
`github_runner_autoscaler_scale_set_memory_reservation_bytes` and
`github_runner_autoscaler_scale_set_memory_limit_bytes`, and
`github_runner_autoscaler_scale_set_info{scale_set,registration,owner,repository}`
maps each lane to the GitHub repository it serves (repository is empty for an
organization-scoped registration, which serves many) so queue-depth metrics
can be joined to the lane that should drain them.

The margin must be greater than zero and less than one. Admission is
candidate-sized rather than a global runner-count reduction: if a 12 GiB E2E
runner does not fit but a 2 GiB runner does, the smaller scale set can still use
the remaining capacity. For example, one 12 GiB reservation on a 16 GiB host
allows a 2 GiB candidate with the default margin but rejects a second 12 GiB
candidate.

### Host-level runner slice

Reserved-memory admission above only ever gates _future_ placements. It does
nothing about runners already admitted: three runners each individually
inside their own ceiling can still grow together past what the host actually
has, because nothing bounds them collectively once they are running
(agent-lcars#1700, raised in review of #1689). The host-level runner slice
closes that gap by giving every runner container on a host a shared cgroup
ceiling, independent of and in addition to its own `runner_memory` limit:

```yaml
fleet:
  placement:
    memory_safety_margin: 0.10
    runner_cgroup_parent: homelab-runners.slice # default; "" disables
```

Every runner container is created with `HostConfig.CgroupParent` set to this
slice (Docker's `--cgroup-parent`), so on a systemd/cgroup v2 host the
kernel enforces one collective `memory.max` across every co-tenant runner on
that host, not just each container's own limit. Docker's systemd cgroup
driver requires a bare slice name (no slashes) ending in `.slice` -- an
invalid `runner_cgroup_parent` fails config validation for the same reason.
The slice itself needs no host provisioning: systemd creates a missing
`.slice` unit implicitly the first time anything references it (this is
systemd's own documented behavior, not Docker's -- see [Red Hat, "Managing
cgroups with
systemd"](https://www.redhat.com/en/blog/cgroups-part-four): "if a parent
does not exist, systemd creates it for you"; Docker's own [`dockerd`
reference](https://docs.docker.com/reference/cli/dockerd/) confirms
`--cgroup-parent` under the systemd cgroup driver must be given as a slice
name for exactly this reason). What systemd does _not_ do on its own is put
any limit on that slice -- Docker never sets resource properties on a
`--cgroup-parent` it did not create the unit file for, so the slice exists
unbounded until something applies `MemoryMax`/`MemoryHigh` to it explicitly.

**The autoscaler declares that bound; it does not apply it (agent-lcars#1712).**
An earlier version of this feature tried to apply `MemoryMax`/`MemoryHigh` to
the slice itself, by running a systemd property change on the host directly
for a `docker: local` target, or over the pinned fleet SSH key for a
`docker: ssh://user@host` remote/SSH-proxied host. That failed on every host,
on every placement, because it cannot succeed under this fleet's privilege
model: the controller image has no systemd bus access of its own, and the
fleet SSH automation key runs behind a forced-command dispatcher that
authorizes exactly two commands -- neither a unit-property change -- by
design (homelab#1061); widening that allowlist would hand the controller
root-equivalent authority over every host, which is the wrong direction.
Host resource policy belongs to Ansible, not the controller.

So the controller only computes and publishes the bound Ansible must
declare and Prometheus must verify -- `runnerSliceBudget` in
`runner_slice.go`, computed the same place `github_runner_autoscaler_host_memory_budget_bytes`/`_observed_bytes`
are (`pickHostLocked` in scaler.go), for every placement host whenever its
physical memory is (re)observed, independent of which placement (if any) is
actually admitted:

```
memory.max  = physical_memory × (1 − memory_safety_margin)
memory.high = memory.max × 0.95
```

`memory.high` sits 5% below `memory.max` so cgroup reclaim pressure inside
the slice starts before the hard ceiling is hit, giving the kernel room to
throttle/reclaim within the runner slice rather than reaching for the OOM
killer against the control plane, registry, or exporters sharing that host.
These numbers are published as:

- `github_runner_autoscaler_runner_slice_expected_memory_max_bytes{host,slice}`
- `github_runner_autoscaler_runner_slice_expected_memory_high_bytes{host,slice}`

Nothing is published for a host while `runner_cgroup_parent` is disabled
(`""`). **Enforcement** is a static systemd unit file declared by Ansible in
the homelab repo (jlapenna/homelab#1102) that sets these same
`MemoryMax`/`MemoryHigh` properties and re-realizes edits live via
`daemon-reload`, with no controller involvement at runtime. **Verification**
is Prometheus comparing the two gauges above against cAdvisor's own
`container_spec_memory_limit_bytes{id="/homelab.slice/<slice>"}` series --
cAdvisor already exports the nested slice cgroup (systemd places
`homelab-runners.slice` at
`/sys/fs/cgroup/homelab.slice/homelab-runners.slice/`), so no new emitter is
needed; homelab's `RunnerSliceUnbounded`/`RunnerSliceBoundDrift` alerts fire
on a mismatch between the declared and the enforced value.

**Follow-up: correlated measurement (tracked on agent-lcars#1700, kept
open).** The slice bound above is a ceiling, not evidence that co-tenant
runners actually approach it. Before raising `memory_overcommit` above 1.0
per host (agent-lcars#1694), collect two weeks of the p99 of the _per-host
sum_ of co-tenant runner RSS -- not each runner's own p99 treated as
independent, which is exactly the assumption #1689's review flagged as
unsafe. `runner` on
`github_runner_autoscaler_runner_job_info{scale_set,runner,job_id,job_name,workflow,repository}`
(agent-lcars#1693) is the container name, which is also cAdvisor's `name`
label -- the same identity "Measuring per-job memory" below already relies
on -- confirming that summing cAdvisor's per-container series by
container-name pattern correctly captures every autoscaler-managed runner
and nothing else. cAdvisor's own scrape target already identifies the
physical host (its `instance` label), so the per-host sum needs no
additional join:

```promql
quantile_over_time(0.99,
  sum by (instance) (
    max_over_time(container_memory_max_usage_bytes{name=~"runner-.*"}[5m])
  )[14d:5m]
)
```

This takes, at each 5-minute sample over the two-week window, the sum across
every runner container co-resident on a host of that container's peak
memory since the previous sample, then reports the 99th percentile of that
per-host sum series. Swap in a `runs-on`/`job_name` breakdown from
`runner_job_info` (as in "Measuring per-job memory") to see which jobs drive
a host's total when this is elevated. Enable the higher overcommit factor
only once this shows the slice bound is never approached at the proposed
reservation on the hosts it would apply to.

## Measuring per-job memory

Container labels are fixed at create time and a JIT runner only learns its
job when GitHub assigns one, so the runner-to-job association is a metric:
`github_runner_autoscaler_runner_job_info{scale_set,runner,job_id,job_name,workflow,repository}`
is 1 for every busy runner and disappears on completion (agent-lcars#1693).
`runner` is the container name, which is also cAdvisor's `name` label, so the
peak memory of every job over a week is one query:

```promql
quantile by (job_name) (0.95,
  max_over_time(container_memory_max_usage_bytes{name=~"runner-homelab-autoscale-.*"}[7d])
  * on (name) group_left (job_name, workflow)
  label_replace(last_over_time(github_runner_autoscaler_runner_job_info[7d]), "name", "$1", "runner", "(.*)")
)
```

Swap `quantile` for `max` or `count` to size a lane's ceiling or see how many
runs a job name accounts for; this is the measurement the light/heavy tier
split is made from.

New runner containers record their exact reservation (not the ceiling) in
the `autoscaler.runner-memory-bytes` Docker label. That makes accounting stable
across live config reloads; a missing label is a current-image contract error.
In-flight reservations are held under the same fleet coordinator lock as host
selection, closing the count/admit race across scale sets and registrations.

A scale set without `runner_memory` retains the historical unbounded behavior
and does not consume a declared reservation; set the field on every workload
that should participate in this safety model. If Docker cannot report physical
memory or an existing runner's reservation, a memory-bounded candidate is
withheld from that host rather than guessed onto it.

Observability:
`github_runner_autoscaler_host_memory_reserved_bytes{host}` reports running
plus in-flight declared reservations observed during placement;
`github_runner_autoscaler_host_memory_budget_bytes{host}` reports physical
memory after the safety margin; and each host that lacks budget for the
candidate increments
`github_runner_autoscaler_placement_blocked_total{host,reason="memory_reservation"}`.
The placement log includes physical, budget, running, in-flight, and candidate
byte values for each rejected host.

This is admission control, not a replacement for the runtime overload gate
below. Reserved-memory admission answers whether declared worst-case limits fit
before a container starts; CPU, PSI, available-memory, and swap telemetry still
react to measured host behavior after workloads are running. Both checks must
pass for a bounded candidate to be placed.

### Usage-aware charging and bounded overcommit

Declared reservations are a floor, not a measurement: a runner that blows past
its `runner_memory_reservation` still only _charges_ the host for the smaller
declared figure unless admission also looks at what it is actually using. For
every running autoscaled runner found during the same inventory pass, the
scheduler samples its current memory usage (Docker's one-shot container
stats, excluding reclaimable page cache) and charges the host the larger of
that sample and the runner's declared reservation:

- **Over its reservation** (using more than it declared): charged at its
  sampled usage, so a host cannot be oversold by pretending the runner still
  only needs its reservation.
- **Under its reservation** (using less than it declared): still charged at
  the declared reservation, so a quiet runner cannot make a host look safer
  than the reservation model actually guarantees.
- **Sample unavailable** (a short timeout, or a transient daemon error):
  charged at the declared reservation, exactly as before this existed.

In-flight reservations (runners not yet started) have no running container to
sample and stay charged at their declared reservation, as before. The sampler
is an injectable function on `Scaler`, so tests supply canned per-container
usage without a real Docker daemon.

Per fleet host, an optional `memory_overcommit` factor (default `1.0`, at
least `1.0` and at most `2.0`) multiplies the reserved-memory admission
budget:

```yaml
fleet:
  hosts:
    - name: laforge
      docker: ssh://runner@laforge
      memory_overcommit: 1.25 # 30 GiB hosts: docs/fleet-scheduler-redesign.md#C
```

The factor only applies while the host's latest load sample (the same cache
the overload gate below reads, not a fresh probe) shows it unpressured:
available-memory ratio above `memory_soft` **and** memory PSI below
`psi_soft`. If either soft threshold is crossed, or the host's telemetry is
missing or stale, the effective factor drops to `1.0` for that placement
attempt -- overcommit never operates on a host admission cannot currently
vouch for. `lane_admissible_slots` (below) is computed from the identical
effective budget and usage-aware charge `pickHostLocked` itself admits
against, so the gauge and the real admission decision can never disagree.

Observability:
`github_runner_autoscaler_host_memory_observed_bytes{host}` reports the sum
of sampled usage across a host's running autoscaled runners (falling back to
a runner's declared reservation when its sample failed) -- purely
observational, never itself charged;
`github_runner_autoscaler_host_memory_overcommit_effective{host}` reports the
factor actually applied just now (`1.0` or the configured value); and
`github_runner_autoscaler_host_memory_budget_bytes{host}` already includes
the effective overcommit factor in its figure. The "Host lacks aggregate
reserved-memory capacity for runner" log line adds a
`memory_overcommit_effective` field alongside its existing byte values.

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
virtual penalty; and each hard-overloaded or still-cooling-down host
increments
`github_runner_autoscaler_placement_blocked_total{host,reason="overload"}`,
distinct from `host_limits` (hosts busy with other work, not pressured) and
from `readiness` (hosts withheld by an operator signal, not their own load).

## Lane capacity: admissible slots

`github_runner_autoscaler_lane_admissible_slots{scale_set}` is how many more
runners a lane could place right now, computed by the exact same admission
pass `pickHostLocked` uses to pick a host (agent-lcars#1695) — the fleet
scheduler design's ["capacity as a first-class
metric"](../../docs/fleet-scheduler-redesign.md). It is a sum over every
host that is reachable, past its readiness gate, within its configured
`runner_limit`, and not hard-overloaded or still cooling down:

- A memory-bounded lane (`runner_memory` set) contributes
  `floor((memory budget − reserved) / memoryReservation())` per host, where
  `reserved` is running plus in-flight declared reservations, capped by that
  host's remaining `runner_limit` headroom.
- An unbounded lane (no `runner_memory`) contributes only the host's
  remaining `runner_limit` headroom, since there is no memory ceiling to
  divide by. A host with neither bound configured cannot contribute a finite
  number and is left out of the sum rather than reported as infinite
  capacity.

The gauge refreshes on every placement attempt (whether or not it succeeds)
and at least once a minute via the fleet-wide tracked-runner reconciler, so
it stays current even while a lane sits at its desired count with nothing
pending. Because it shares `pickHostLocked`'s own host inventory pass rather
than re-deriving the computation, it cannot drift from the real admission
decision — this is also what `placement_blocked_total`'s new `host` label
(above) exists to make legible per host: "which constraint binds where" is a
dashboard panel instead of a log grep.

## Priority reservation: minimum service share, capacity-aware

A scale set can declare `priority` (default `0`, higher numbers take
precedence):

```yaml
fleet:
  scale_sets:
    - name: homelab-ci
      priority: 10
      weight: 1
      ...
    - name: homelab-control
      # priority omitted -- ordinary tier
      weight: 1
      ...
```

The gate this configures is a **minimum service share, not strict
priority**: a higher-priority lane with pending demand and no active or
in-flight runner of its own gets first claim on the next placement, but only
when that lane would otherwise be left with **zero admissible slots**
fleet-wide. `reserve` picks a host for the lower-priority candidate first,
then evaluates the protected lane's own `laneAdmissibleSlotsOverHosts`
computation — the same admission math behind
[`lane_admissible_slots`](#lane-capacity-admissible-slots), scoped to the
protected lane's own memory reservation and host limits, which can differ
from the candidate's — with the candidate's reservation hypothetically
applied to the host it picked. Only when that leaves the protected lane with
fewer than one admissible slot does `reserve` actually refuse; otherwise the
lower-priority placement proceeds normally (agent-lcars#1718).

This distinction matters because a fleet with free capacity everywhere is
common: one active or in-flight runner already satisfies a lane's minimum
service share, so an established lane keeps using every remaining slot even
while a higher-priority lane is momentarily busy — and, since agent-lcars#1718,
a higher-priority lane simply being _pending_ no longer serializes every
other lane behind it either, as long as the fleet can still serve both. On
2026-09-02, before this fix, a 2 GiB `homelab-autoscale-control` runner was
refused for 90 seconds by a `priority: 10` `homelab-autoscale-homelab-ci`
lane that had a job pending and no runner of its own yet — while 15
admissible slots sat free fleet-wide. The gate refused unconditionally
whenever the protected lane had zero active runners, without ever checking
whether the fleet had room for both.

A refusal increments both
`github_runner_autoscaler_placement_blocked_total{scale_set,host="",reason="priority_reservation"}`
(the fleet-level reason shared with every other capacity-shaped refusal) and
`github_runner_autoscaler_priority_reservation_refusals_total{scale_set,protected}`,
which names the specific lane that was protected — join it to
`lane_admissible_slots{scale_set="<protected>"}` to see how tight its
capacity actually was. The refusal is also logged at `INFO` with the
protected lane's name, its pending count, and the admissible-slot figure the
decision was based on.

## Host roles and the fleet invariant

Each fleet host declares its standing in the fleet invariant with an optional
`role` (agent-lcars#1696, `docs/fleet-scheduler-redesign.md#F`):

```yaml
fleet:
  hosts:
    - name: laforge # role omitted -- defaults to permanent
      docker: ssh://runner@laforge
    - name: laptop
      docker: ssh://runner@laptop
      role: opportunistic
    - name: pike
      docker: ssh://runner@pike
      role: maintenance
```

- **`permanent`** (the default when `role` is omitted) is an ordinary host:
  it counts toward both admissible-slots gauges below.
- **`opportunistic`** hosts (laptop) are placed on exactly like a permanent
  host whenever they are reachable and past their readiness gate —
  `pickHostLocked` makes no distinction — but never count toward the
  permanent-only gauge, so losing one (closing the lid) never fires an alert
  that reads that gauge.
- **`maintenance`** hosts (pike) are never placement candidates. Every
  inventory probe forces them ineligible and counts it under
  `placement_blocked_total{host,reason="maintenance"}`, but the host stays
  declared in `fleet.hosts` — so `github_runner_autoscaler_host_reachable{host}`
  and `github_runner_autoscaler_host_ready{host}` keep reporting on it exactly
  as they would for any other managed host. This is additive: removing a host
  from `fleet.hosts` entirely is still how you stop connecting to it at all
  (pike's credentials-revoked/re-entry preflight is unchanged by this field —
  see "Host readiness gate" and the homelab operational docs). Use
  `maintenance` for a host you want the fleet to keep reachability/readiness
  telemetry on while it never receives work.

`github_runner_autoscaler_host_role_info{host,role}` is a static `1` per
configured host, for joining a dashboard or alert to the role that host
carries right now.

`github_runner_autoscaler_lane_permanent_admissible_slots{scale_set}` is
`lane_admissible_slots` restricted to `role: permanent` hosts — the same
per-host slot computation, just filtered by host name before summing, so the
two gauges can never disagree on the underlying arithmetic. This is the gauge
the fleet invariant is about: a lane with pending consumers should always have
at least one admissible slot on a host the fleet actually depends on, and that
must stay true independent of whether an opportunistic host happens to be
reachable right now. homelab's `RunnerLanePermanentCapacityLow` alert
(`observability/prometheus/rules.yml`) reads this gauge, not
`lane_admissible_slots`, for exactly that reason.

## Placement degradation ladder

When no reachable host admits a lane's declared reservation, and the lane
opts in, placement walks an ordered degradation ladder instead of refusing
outright (agent-lcars#1697, phase 3 of
[`docs/fleet-scheduler-redesign.md#D`](../../docs/fleet-scheduler-redesign.md#d-a-degradation-ladder-with-a-floor)).
**The declared reservation is the normal path; the ladder is the exception
path, counted per rung** — a healthy fleet never touches it, and every time
it does is a Prometheus counter, not a silent decision. Default is off, both
fleet-wide and per lane: with the ladder disabled, a lane's rung-1 failure is
byte-for-byte the pre-ladder refusal.

```yaml
fleet:
  placement:
    degradation_ladder:
      enabled: false # fleet-wide default; off unless a lane overrides it
      prometheus_url: http://prometheus:9090
      observed_window: 168h
      observed_quantile: 0.95
      observed_query: >-
        quantile({{.Quantile}}, max_over_time(container_memory_rss{container_label_autoscaler_scale_set="{{.ScaleSet}}"}[{{.Window}}]))
      refresh_interval: 10m
scale_sets:
  - name: ci-heavy
    ...
    degradation_ladder: true # per-lane override; canary this lane first
```

A lane is ladder-enabled iff its own `degradation_ladder` override is
`true`, or the override is unset and the fleet-wide `enabled` is `true`; an
explicit `false` always wins over the fleet default. `prometheus_url`,
`observed_window`, `observed_quantile`, `observed_query`, and
`refresh_interval` are fleet-wide only, not per lane. `observed_query` is a
Go `text/template` string rendered with `.ScaleSet`, `.Window`, and
`.Quantile`; `observed_quantile` must be in `(0, 1]`, and `observed_window`
and `refresh_interval` must be positive durations.

The ladder only runs once rung 1 fails for a ladder-enabled lane:

1. **Declared reservation** (normal, uncounted). Exactly today's admission:
   `runner_memory_reservation` (or `runner_memory` when unset) charged
   against a host's aggregate reserved-memory budget.
2. **`observed_p95`**: admit on the least-loaded candidate whose free budget
   covers the lane's _observed_ p95 memory instead of its declared
   reservation, provided the host is not hard-overloaded and not
   soft-pressured (`memory_soft`, PSI, or swap — the same gates rung 1
   already respects, just against a smaller number). The observed figure
   comes from an instant Prometheus query (`observed_query`, rendered per
   scale set), refreshed every `refresh_interval` for ladder-enabled lanes
   only and never on placement's own critical path — the query runs
   asynchronously, with a bounded 5s timeout, from a background refresher
   that populates a shared cache placement only ever reads. A sample older
   than `3 * refresh_interval`, a failed query, or no `prometheus_url`
   configured at all means rung 2 is skipped (the ladder goes straight from
   rung 1 to rung 3).
3. **`free_memory_floor`**: admit exactly one runner on the least-loaded
   reachable, non-hard-overloaded host whose latest real node-exporter
   `MemAvailable` sample exceeds the lane's ceiling (`runner_memory`),
   regardless of any declared reservation. At most one such runner per host
   at a time — claimed the moment it is picked, released when that runner
   completes or is removed, and cordoning that host from every rung (for
   every lane) until then. This is the floor invariant: **a reachable idle
   host with more free memory than the job's ceiling always runs the job.**
4. **`refused`**: no rung admitted the candidate. Identical to the
   pre-ladder refusal — `lane_admissible_slots{scale_set}` already reads
   `0` — except now counted per rung so a canary review can tell "the fleet
   is genuinely full" from "nothing looked at this yet".

Observability:
`github_runner_autoscaler_placement_degraded_total{scale_set,rung}` counts
every rung-2/3/4 decision (rung 1 is never counted here — it's the normal
path, not a rung); `github_runner_autoscaler_placement_degraded_active{scale_set,host}`
tracks rung-3 runners currently in flight, at most `1` per host;
`github_runner_autoscaler_lane_observed_memory_p95_bytes{scale_set}` and
`github_runner_autoscaler_lane_observed_memory_age_seconds{scale_set}`
publish rung 2's Prometheus-sourced input for every ladder-enabled lane,
refreshed on the same `refresh_interval` (neither is published until the
first successful query succeeds). Every degraded placement is also logged at
`INFO` with the scale set, host, rung, reserved bytes, and the figure that
justified it (the observed p95 for rung 2, the host's real `MemAvailable`
for rung 3).

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

`SIGUSR1` still performs the full drain for the cases that genuinely need an
empty fleet — removing a scale set, decommissioning a host. **A routine
deploy must never send it.** Quiesce + checkpoint + adopt (above) is the
whole restart story; a deploy that falls back to `SIGUSR1` gets the failure
mode the rest of this section documents instead of a safe restart.

### Drain semantics (`SIGUSR1`)

Sending `SIGUSR1` to the orchestrator process begins a **fleet-wide** drain:
every configured scale set stops accepting new placements while its
already-assigned jobs finish normally. The listener's own gauge,
`github_runner_autoscaler_draining{scale_set}`, is the source of truth for
whether a given lane is currently refusing work; a monitor (or a deploy
script gating a restart on an empty fleet) should read it per scale set
rather than inferring drain state from runner counts alone.

**The drain is acknowledged before any teardown work starts.** On the first
`SIGUSR1`, the signal handler loops over every scale set marking it draining
and setting its `draining` gauge to `1` -- a fast, in-memory-only pass with
no Docker or GitHub calls on it. Only after every lane has been marked does
idle-runner teardown begin, running **concurrently** across scale sets with
its own bounded per-operation timeouts (`removeIdleRunnerTimeout`,
`deregisterRunnerTimeout`: 15s each). Before agent-lcars#1722, marking and
teardown were one synchronous call applied to each scale set in turn, so a
single scale set with an unreachable Docker host could delay every later
scale set's `draining=1` by tens of seconds -- observed as 4 of 5 controller
deploys in one day missing a deploy script's 30s fleet-wide drain
acknowledgement. Now every lane's gauge reads `1` within about as long as
the marking loop itself takes to run, regardless of how slow or unreachable
any single lane's hosts are.

**Placements refused during a drain stay visible, not silent.** Each
`HandleDesiredRunnerCount` callback GitHub sends while a scale set is
draining:

- keeps `github_runner_autoscaler_desired_runners{scale_set}` tracking the
  real target (`min(max_runners, min_runners + assigned)`) instead of
  freezing it at whatever it last read before the drain started -- GitHub
  keeps assigning jobs throughout a drain, and a frozen gauge previously made
  a drain that outlived its deploy indistinguishable from a lane with no
  demand;
- increments `github_runner_autoscaler_placements_refused_draining_total{scale_set}`
  on every refused call, so a drain sitting open long after its deploy
  finished shows up as accumulating refusals in the same place as ordinary
  demand;
- logs `"Refusing runner placement while draining"` at INFO **once per
  drain** (naming the scale set and the currently assigned job count), not
  once per callback -- callbacks arrive far more often than an operator
  needs to see the same fact repeated.

**A stuck drain self-heals, loudly.** `drainStuckTimeout` (5 minutes) bounds
how long the fleet may sit fully drained (every scale set at zero runners)
before the watchdog concludes an operator's drain-and-restart cycle was
interrupted before its recreate step (Ctrl-C, an SSH drop, a refused
unreachable host) and clears drain mode fleet-wide on its own. When it does,
it logs at WARN with both how long the fleet sat stuck and
`assigned_jobs_waiting` -- the sum of each scale set's most recently
observed GitHub-assigned job count, i.e. how much demand sat refused for the
duration -- and increments
`github_runner_autoscaler_drain_auto_cleared_total{scale_set}`. Sustained
nonzero on that counter indicates a deploy script keeps getting interrupted
before its recreate step (homelab#321).

**A second `SIGUSR1` while already draining ends the drain immediately,**
without waiting for `drainStuckTimeout`. This is the explicit end-drain
signal: it exists so an operator -- or a deploy script (homelab#1130) that
sent the first `SIGUSR1` and then decided not to proceed with a restart --
can recover a drain it abandoned on demand instead of waiting up to 5
minutes for the watchdog. It does **not** increment
`drain_auto_cleared_total`: that counter means specifically "the watchdog
concluded this was stuck and healed it unattended," and an operator's
explicit request is neither. In short, the full signal contract is:

| Signal                                 | Effect                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `SIGUSR1` while not draining           | Begin a fleet-wide drain.                                                 |
| `SIGUSR1` while already draining       | End the drain immediately (explicit; no `drain_auto_cleared_total`).      |
| (5 minutes at fleet-wide zero runners) | Watchdog ends the drain automatically; logs WARN, counts as auto-cleared. |

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
containers are not adopted on that pass — already what happened when the list
call itself failed.

The periodic sweep is what recovers from that, and it has to **adopt** those
runners, not merely tolerate them. A running container this scale set owns but
does not track counts against neither host limits nor fleet capacity, and when
its job finishes there is no entry for `HandleJobCompleted` to reconcile, so
the container is never removed and leaks until the process restarts. The sweep
therefore adopts any owned, untracked, running container older than the
orphan-minimum age — old enough that it cannot be one another goroutine is
still starting.

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

The queue executor (see "Queue executor" above) is process-lifetime too, for
the same reason, though it is not one of `validateReloadCompatibility`'s
rejections: its console and credential environment is not part of
`orchestrator.yml`, so there is nothing for a reload to reject -- the poller
goroutine simply never learns a reload happened.
