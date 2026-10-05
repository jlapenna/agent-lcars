# runner-autoscaler

Go source for the LCARS queue executor: a long-running process that polls
the console's Work API and launches ephemeral "direct-runner" containers
as Kubernetes Jobs or across a shared Docker host pool for admitted work items. Also includes
`runner-image/` and `control-plane-image/` (Dockerfiles for images still
consumed by Actions Runner Controller pods on k3s) and is a sibling of
`tools/e2e-runner/`.

This package used to also run a custom multi-scale-set GitHub Actions
runner-fleet control plane (independent GitHub scale-set listeners across
`supersprinklesracing/sprinkles` and `jlapenna/agent-lcars`, with its own
host-load-aware placement, degradation ladder, drain semantics, and restart
checkpoint). Every GitHub Actions runner lane has migrated onto Actions
Runner Controller (homelab#1623); that scale-set runner management was
retired in Phase 3 of that issue. The queue executor below is this process's
only remaining job.

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

## Configuration

Optional `arc_lanes` entries publish listener capacity to the console using
the existing telemetry writer (`AGENT_LCARS_AUTOSCALER_STATUS_ENABLED=true`):

```yaml
arc_lanes:
  - name: example-ci
    registration_url: https://github.com/example/repository
    metrics_url: http://cluster.example:30081/metrics
```

Derive this list from the deployment's ARC lane inventory. Each listener is
fetched independently every ten seconds with a five-second deadline. Complete
capacity snapshots use `schemaVersion: 3`, `kind: arc-lane` in `runner-status`;
failed or incomplete scrapes expire after thirty seconds. Pending jobs mean
`max(assigned - running, 0)`, while desired, registered, idle and maximum
runners retain ARC's own semantics. They are separate from Kubernetes Pending
pods and from QueueExecutor's native Work capacity.

`orchestrator.yml`'s only live schema is:

```yaml
version: 1
server:
  metrics_addr: 127.0.0.1:8080 # optional, this is the default
  log_level: info # optional, this is the default
  log_format: text # optional, this is the default
fleet:
  hosts:
    - name: janeway
      docker: local
    - name: laforge
      docker: ssh://homelab@laforge.lan.jlapenna.net
    - name: laptop
      docker: ssh://homelab@laptop.ts.jlapenna.net
      readiness_url: http://homelab.lan.jlapenna.net:9100/metrics # optional
      readiness_metric: host_ready # optional, this is the default
```

`fleet.hosts[].{name,docker}` is almost all of fleet configuration the queue
executor reads: `docker` is `local` (the mounted socket) or
`ssh://user@host` (proxied over the fleet SSH key, same as before -- see
`hosts.go`). Which of these configured hosts ever enters the launch pool at
all is decided once, at startup, by `direct_runner_preflight.go`'s own
disposable credential-mount probe, not by anything else in this file.

`readiness_url` and `readiness_metric` add a second, per-launch eligibility
gate on top of that startup preflight, for a host whose online-ness can
change while the process keeps running -- a travelling, battery-powered
laptop being the motivating case (homelab#1664/homelab#1623). When
`readiness_url` is set, `directRunnerCapacityReservations.reserve` fetches it
fresh (3s timeout) as part of every capacity check that reaches that host --
on every poll tick (default 15s), whether or not a run is actually claimed
that tick, not only immediately before a successful launch -- and requires
`readiness_metric` (default `host_ready`) to be present with value `1`; a
failed fetch, a non-1 value, or a missing metric all skip the host for that
check (`github_runner_autoscaler_queue_executor_host_unready_total{host}`,
logged at Info) without touching probeErr/inventory-fault handling, and the
reservation moves on to the next configured host exactly like a full one. If
every configured host is unready, the claim is left queued -- the same
"no capacity" outcome (`capacity_wait`) as an entirely full fleet, not an
error. A host with no `readiness_url` is always eligible, which is every
existing deployment's behavior today, unchanged. The endpoint is expected to
be a Prometheus-exposition HTTP response (e.g. a node-exporter textfile
collector); this binary has no opinion about what publishes it or what the
metric means (Tailscale LAN presence, mains power, anything else) -- that is
deployment knowledge that belongs entirely to the config that sets
`readiness_url`, never to this repo (see `AGENTS.md`'s cross-repository
independence rule). The per-host distinction comes from each host pointing at
its own `readiness_url`, not from a label inside the metric body, so a bare
`host_ready 1` line is exactly as valid as one carrying labels.

This gate only ever narrows the fixed pool `direct_runner_preflight.go`
establishes at startup -- it cannot widen it. A host that is offline (fails
the startup credential-mount preflight) never joins the launch pool later no
matter what its readiness metric reports afterward; only a full daemon
restart re-runs that preflight. A travelling laptop therefore still needs to
be reachable at controller-startup time at least once per daemon generation,
same as every other host -- `readiness_url` governs whether an
already-admitted host may receive the _next_ launch, not whether it can join
the pool at all.

A deployment's `orchestrator.yml` may still carry retired scale-set sections
(`github`, `registrations`, `scale_sets`, `fleet.max_runners`,
`fleet.placement`, `fleet.file_mount_allowlist`, `server.state_path`, and
legacy per-host keys like `runner_limit`/`role`/`require_readiness`) from
before this retirement. The parser accepts and ignores them rather than
refusing to start, and logs a startup warning naming every ignored section
so an operator notices the dead weight instead of it being silently
mistaken for live configuration. A follow-up change in the config's own
repository (`jlapenna/homelab`) removes them from the file.

Send the running process `SIGHUP` after atomically replacing
`orchestrator.yml` to revalidate it and swap in the new Docker host
configuration for everything except the queue executor itself: validation
re-probes connectivity to every configured host, but the queue executor's
own launch host pool (`direct_runner_preflight.go`'s preflight result) is
captured once at startup, same as its console/credential environment -- see
"Queue executor" below. Changing the Docker fleet needs a full restart to
actually take effect for direct-runner launches, even though a `SIGHUP`
reload with the new hosts succeeds.

## LCARS live runner status

The queue executor can publish its current readiness, draining state, and
active-run count to the LCARS console. It writes one bounded document
(`schemaVersion: 2`, `kind: "queue-executor"`) to the existing
`agent-telemetry` Firestore database; the console already has read-only
access there. This keeps the console out of the launch path and does not
grant it a new writer role.

Publishing is deliberately opt-in and fail-soft. Set these only in the
homelab deployment, with the existing telemetry-writer credential mounted as
`GOOGLE_APPLICATION_CREDENTIALS`:

```sh
AGENT_LCARS_AUTOSCALER_STATUS_ENABLED=true
AGENT_TELEMETRY_PROJECT_ID=agent-lcars
AGENT_TELEMETRY_DATABASE_ID=(default)
GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/telemetry-writer.json
```

The credential stays in the encrypted homelab secret store. A missing or
temporarily unavailable credential logs a warning and never blocks a claim or
launch. Snapshots publish immediately on startup and then every 10 seconds;
the console stops presenting a snapshot as live after 30 seconds without an
update. It reports only generic worker health: readiness, draining,
configured direct-container capacity, and an active-container count when
every Docker host can be read. It has no pipeline, repository, provider,
credential, or individual-run data -- queue lifecycle counts (queued,
claimed, running, and outcomes) remain the console's authoritative
orchestrator Run records, not autoscaler telemetry.

The scale-set runtime this process used to also run published one additional
document per scale set to the same collection (`schemaVersion: 1`); that
publication was retired along with the scale-set code itself. The console
(`apps/console/src/lib/autoscaler-status.ts`) still reads and tolerates that
shape, so no console change was needed -- those documents simply stop being
written and age out of the console's 30-second staleness window.

## Queue executor (direct-mode runners)

Server-dispatched work: a goroutine that polls the console's `POST
/api/work/v1/runs/claim` and, on a successful claim, launches one direct-mode
runner container (not GitHub-registered, one-shot). The console routes every
admitted run through this one server-authoritative executor; the run's
pipeline selects only its provider adapter after the queue has claimed it.
Its configuration is:

```sh
LCARS_CONSOLE_URL=https://lcars.jlapenna.net
LCARS_WORK_AUDIENCE=agent-lcars-work
GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/telemetry-writer.json
LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH=/secrets/telemetry-writer.json
LCARS_QUEUE_CLAUDE_TOKEN_HOST_PATH=/secrets/claude-code-oauth-token
LCARS_QUEUE_OPENCODE_KEY_HOST_PATH=/secrets/opencode-llm-api-key
LCARS_QUEUE_MAX_CONCURRENT=1
LCARS_QUEUE_RUNNER_IMAGE=registry.example.com/homelab-runner:jit-node24
```

With those durable console and credential settings present, daemon startup
also runs a disposable Docker bind-read probe on every configured host. Only
hosts that can read the telemetry, Claude, and OpenCode mount files enter the
direct queue's launch pool; unavailable laptops and other failed probes remain
outside that pool. The poller starts only when at least one eligible host
passes, then sends a claim body containing only its runner identity.
The server derives claimable pipelines from the authenticated `work.executor`
grant; no autoscaler-local pipeline allowlist exists.

Admission is provider-aware. The server selects the FIFO head of the granted
pipeline with the fewest live claimed runs; provider-head age breaks occupancy
ties. This keeps a busy provider from taking the next released fleet slot while
another granted provider has fewer live claims. OpenCode is serialized because
its sessions share the local inference backend, and Codex is serialized because
its global subscription credential lease admits one session. Claude remains
bounded by fleet host capacity. The claim request cannot select pipelines or
change these server-owned limits.

This process has nothing else to run: an unconfigured queue executor (an
absent `LCARS_CONSOLE_URL`, or any required value missing) fails startup and
`--check-config` outright rather than running forever as a silent no-op.

### Kubernetes Jobs

A top-level `kubernetes` section selects Kubernetes instead of Docker. The
singleton controller uses the standard Kubernetes Go client; `kubeconfig`
selects a restricted external credential, and an omitted path uses in-cluster
ServiceAccount authentication. In this mode `fleet.hosts` and the Docker
host-path credential environment variables are unnecessary.

```yaml
kubernetes:
  namespace: lcars-work
  kubeconfig: /run/secrets/queue-kubeconfig
  credentials_secret: lcars-runner-credentials
  service_account: lcars-direct-runner
  max_concurrent: 5
  node_selector:
    homelab.jlapenna.net/queue-runner: 'true'
  requests: { cpu: '500m', memory: 2Gi, ephemeral-storage: 4Gi }
  limits: { cpu: '8', memory: 16Gi, ephemeral-storage: 24Gi }
```

The deployment owns namespace, RBAC, node labels/readiness taints, Secret values,
and resource sizing. The example budgets are provisional for rollout, not
measured direct-runner quantiles or binary defaults. Docker direct mode had no
CPU/memory limit; choose burst limits conservatively and measure the new pods
before tightening them. The controller requires namespace Jobs
`get,list,create,update,delete`, namespace Secrets `get,create`, and cluster
Nodes/Pods `list`, plus `get` on the configured worker ServiceAccount. Its
credential never reaches worker pods. Startup verifies the account exists and
write grants are allowed before claiming. `--check-config` performs the same
read-only API inventory and permission preflight before a deployment stops its
previous controller; it creates no Jobs, Secrets or workers. The provider
Secret must have nonempty `telemetry-writer.json`, `claude-code-oauth-token`, and
`opencode-llm-api-key` keys. Each pod projects only the writer and its own
provider key. Codex restores subscription credentials through the existing
Console broker and keeps rotating credentials/transcripts in a 64Mi memory
`emptyDir`. Workers disable ServiceAccount token mounting, run as uid/gid 1001,
and use no host paths, Docker socket, or SSH key.

Worker pods use `ClusterFirst` DNS with `ndots:1`. External bootstrap and provider
API names such as `chatgpt.com` are queried before Kubernetes search suffixes,
avoiding musl resolver failures on search responses. Bare cluster service names
still use the cluster search list. This default is part of the controller's Job
manifest; adopting it requires the published controller image, not a worker-image
rebuild, and applies to newly created Jobs.

Before claiming, the controller counts unfinished Jobs (including Pending or
suspended Jobs), reserves a process-local slot, and checks matching nodes for
Ready, cordon and taint eligibility plus free CPU/memory/storage/pod requests.
Accounting includes every namespace and the scheduler's init-container,
sidecar and pod-overhead rules. API uncertainty or no capacity leaves work
queued. Kubernetes makes the final placement decision: another workload can
still consume capacity between this observation and scheduling. Optional
`tolerations` require explicit keys, `Exists` or `Equal`, and `NoSchedule`;
do not tolerate deployment readiness, inference-busy, or maintenance taints.
`max_concurrent` is a cluster-wide bound for the **singleton** queue controller,
not a distributed reservation protocol; do not overlap controller generations.

Each run has one deterministic Job name. The controller creates it suspended,
creates an immutable per-run token Secret owned by that exact Job, and resumes
it. A restart resumes the same never-started Job only when its matching token
exists. An ambiguous create reads that same name rather than allocating a
replacement. Failed creation remains claimed and recovers through the existing
lease-expiry/bounded-new-generation retry path. Jobs use `restartPolicy: Never`,
`backoffLimit: 0`, `podReplacementPolicy: Failed`, and fail on disruption.
Kubernetes does not promise exactly-once process execution under every node
failure; Work API authentication, completion fencing and provider credential
leases remain authoritative. Jobs have a two-hour wall-clock deadline including scheduling and image pulls,
which bounds infrastructure launch waits independently of worker heartbeat
renewal or the normal 80-minute agent budget. They retain
terminated pod logs for a day through the TTL controller, bounded to five
completed Jobs per configured capacity slot by the retention sweep. A suspended shell
older than the two-hour lease window is deleted with UID/resourceVersion
preconditions; running Jobs are never removed by cleanup.

Provision the API boundary first, publish the controller image, pause Docker
claims and wait for live Docker workers to finish, then switch the configuration
and remove the controller's fleet SSH/socket/provider host mounts. Existing
Docker workers remain owned by their original deployment during cutover; the
Kubernetes backend neither adopts nor removes them. A full process restart is
required for backend, credentials, topology or resource configuration changes.

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
to `homelab/default`; the model may be overridden only in the
autoscaler's process environment. The baked OpenCode config consumes the
read-only key file directly, rather than exporting the key to the OpenCode
process, so routine agent tool-shell environment inspection cannot recover it.

Before telemetry starts, the direct runner synchronously initializes
OpenCode's local store with a pure session listing, bounded to 30 seconds by
default (`OPENCODE_BOOTSTRAP_TIMEOUT_SECONDS`, valid range 1-120). This avoids
a first-run migration race between OpenCode and its telemetry sidecar. If an
OpenCode round exits zero after completed verifier lookups find no exact-marker
deliverable, the runner may continue the one unambiguous workspace session
once. That continuation shares the original `OPENCODE_TIMEOUT_SECONDS`
deadline; nonzero exits, verifier lookup failures, structured terminal
handoffs, ambiguous session discovery, and exhausted time stop immediately.

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
its whole lifetime (see "Configuration" above). Changing any of them, or
turning the queue executor on or off, needs a full daemon restart, not a
config-file replace-and-`SIGHUP`.

`LCARS_QUEUE_TELEMETRY_WRITER_HOST_PATH` is the telemetry-writer key's path
**on the Docker host**, not this process's own
`GOOGLE_APPLICATION_CREDENTIALS` path: a claimed run's container is
bind-mounted this file (read-only, at `/run/secrets/telemetry-writer.json`,
the fixed path `direct-runner.sh` reads) by the Docker daemon that actually
creates it, which may be a remote fleet host over SSH -- so it cannot be
inferred from a path meaningful only inside the autoscaler's own container.
Required for queue-executor startup; a missing path fails boot and
`--check-config` before any claim.

`LCARS_QUEUE_MAX_CONCURRENT` (default `1`) caps how many direct-mode
containers may run concurrently on any one host. An explicitly invalid value
fails boot and `--check-config`; it never silently falls back to one.
Placement itself is round-robin over the same `fleet.hosts` pool.

`LCARS_QUEUE_RUNNER_IMAGE` is the one container image reference every
direct-mode run launches, whichever pipeline (Claude, Codex, or OpenCode)
claimed it. It has no fleet-named default: this is deployment-specific
registry/tag knowledge the autoscaler cannot infer, so it is required for
queue-executor startup and a missing value fails boot, naming the variable.

The eligible host targets, image reference, credential bind paths, and concurrency
limit are captured in one startup snapshot. Launches and capacity reservations do
not re-read their environment after claiming work. Credential **contents** still
rotate through the existing per-run file reads.

Direct placement follows the configured tag at launch, like the Kubernetes
Job's `PullAlways`: it resolves the tag's registry digest (10-second deadline)
and pulls on the selected host only when the cached image differs or is absent
(including after image pruning). There is no background refresh loop; the tag
moves only when a new runner image is promoted. A failed digest lookup or pull
keeps the cached image available to the launch. A missing image with an
unavailable registry still fails, as there is no runnable artifact.
For Docker, `--check-config` includes the environment-only queue checks and does
not perform the mutating per-host credential-container probe. For Kubernetes,
it also reads the configured credential Secret, worker ServiceAccount, Jobs,
Nodes and Pods and checks write permissions using SelfSubjectAccessReviews.

### Readiness and claim outcomes

The metrics endpoint exposes the queue worker's own health:

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
- `github_runner_autoscaler_queue_executor_claims_total{pipeline}` counts valid claims by provider pipeline
  returned by the server. `github_runner_autoscaler_queue_executor_launches_total{outcome}`
  then records whether that claim launched a direct runner (`success` or
  `error`). A launch error therefore remains visible as a successful claim
  followed by a failed launch, rather than looking like an idle poll.
- `github_runner_autoscaler_queue_executor_host_unready_total{host}` counts
  capacity checks skipped for one host because its `readiness_url` fetch
  failed or did not return `readiness_metric == 1` (see "Configuration"
  above). It increments on every poll tick that reaches a gated host, not
  only on a successful claim, so an offline host with readiness configured
  accrues it continuously, not once per launch. It is only ever incremented
  for a host that actually sets `readiness_url`.

### Exited direct-runner retention

Direct-mode containers use `AutoRemove: false` so their exit logs remain
available for diagnosis. The queue worker starts a label-scoped sweep on
startup and every 15 minutes. Sweeps run separately from claim polling, are
single-flight, and have a 30-second whole-sweep deadline, so a slow Docker
host or a historical backlog cannot delay a work claim. It considers only
containers whose
`agent-lcars.direct-runner=1` **and**
`agent-lcars.direct-runner.run-id` labels were set by this launcher, and only
after Docker reports them `exited`.

Per Docker host, the five most recent exited direct runners are retained for
up to 24 hours; any older exit or any exit beyond those five is removed. Both
the ordering and age use Docker's inspected `State.FinishedAt`, not the
container creation time, so a long-running runner receives the same evidence
window as a short-lived failure. Removal is non-forcing: if a container races
back to running, Docker refuses the deletion rather than ending an active run.

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

**`SIGUSR1` pauses the queue poller from claiming.** The signal toggles an
in-process flag the poller checks before every claim call: the first
`SIGUSR1` pauses claims, a second resumes them. This is a separate, in-memory
switch from the `queue.state` machine above: it has no effect on runs already
claimed, and nothing else in this repo touches it. A claim minted moments
before this instance is replaced would just be another launch failure to
recover from (see above), so pausing before a redeploy avoids that rather
than preventing it.

### Restart and recovery

A controller restart can interrupt a direct-runner `ContainerCreate`/`Start`.
On startup, before accepting new claims, `recoverCreatedDirectRunners`
(`queue_recovery.go`) scans each configured host's Docker containers by this
launcher's own labels: an owned container still in Docker's `created` state
with a zero `StartedAt` is resumed in place, subject to the host's
direct-runner concurrency limit. This repairs a restart between create and
start without minting a duplicate attempt. Running, exited, previously
started, and foreign containers are never restarted. The adapter's initial
authenticated Work brief rejects settled or expired attempts before checkout
or model execution. Unreachable hosts, full hosts, and ambiguous Docker
starts are retained and reported; normal lease recovery (above) remains the
fallback when startup recovery cannot proceed.

This Docker-label scan is the whole restart story: there is no separate
on-disk checkpoint to restore. A plain `docker compose up --force-recreate`
is a safe redeploy on its own.

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

OpenCode's runner-local loopback proxy observes LiteLLM's selected deployment
header after each response, maps it through the same virtual-key-authorized
`/model/info` endpoint, and persists only the bounded physical model identifier
beside the requested route. Runner hosts never contact llama-swap directly.

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

When another live run holds the global credential lease, the broker's HTTP
409 response leaves the direct runner waiting with its run heartbeat active.
It retries with backoff from 5 to 30 seconds for up to 1800 seconds.
`CODEX_AUTH_WAIT_SECONDS` may be set from 0 through 7200; zero permits one
request without waiting. Other HTTP failures and transport errors are not
retried by this capacity wait. Exhaustion or cancellation reports a sanitized
reason and cleans up volatile state, without persisting or releasing another
run's credential. This behavior requires a runner image built from the fix;
merging the source alone does not update existing images.

Codex session files remain only in the runner's volatile filesystem until the
telemetry sidecar has finalized and archived them; cleanup then removes the
per-run directory. A retained Docker container therefore holds neither the
subscription credential nor its session transcript.

Direct Codex requires the separately reviewed,
repository-prefix-preserving runtime grant on `agent-lcars-codex-auth` and a
single-run canary before activation. This repository does not make that IAM
change; queue readiness does not bypass the broker's lease and repository
authorization checks.

## Deployment

The actual runtime config (`orchestrator.yml`: fleet Docker host inventory)
and the Ansible playbook that deploys this are owned by
[`jlapenna/homelab`](https://github.com/jlapenna/homelab)
(`github-runner-autoscaler/`), which pulls the images this repo's CI builds
and publishes rather than building from source itself -- see that repo for
operational docs (secrets, fleet topology).

Migrated from `jlapenna/homelab` -- see
[agent-lcars#52](https://github.com/jlapenna/agent-lcars/issues/52).
