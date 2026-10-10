# runner-autoscaler

Go source for the LCARS queue executor: a long-running process that polls
the console's Work API and launches ephemeral "direct-runner" Kubernetes
Jobs for admitted work items. Also includes `runner-image/` and
`control-plane-image/` (Dockerfiles for images still consumed by Actions
Runner Controller pods on k3s) and is a sibling of `tools/e2e-runner/`.

This package used to also run a custom multi-scale-set GitHub Actions
runner-fleet control plane (independent GitHub scale-set listeners across
`supersprinklesracing/sprinkles` and `jlapenna/agent-lcars`, with its own
host-load-aware placement, degradation ladder, drain semantics, and restart
checkpoint). Every GitHub Actions runner lane has migrated onto Actions
Runner Controller (homelab#1623); that scale-set runner management was
retired in Phase 3 of that issue. The queue executor below is this process's
only remaining job.

Kubernetes Jobs are the only execution backend. The former Docker backend
(SSH/Docker host inventory, per-host bind-probe preflight and readiness gates,
Docker image refresh, container recovery, and the exited-container sweep) was
removed once production ran only Kubernetes.

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
failed or incomplete scrapes are never written, so the last complete
snapshot expires after three minutes. Pending jobs mean
`max(assigned - running, 0)`, while desired, registered, idle and maximum
runners retain ARC's own semantics. They are separate from Kubernetes Pending
pods and from QueueExecutor's native Work capacity.

Each successful lane snapshot repeats `expectedLanes`: the sorted,
comma-separated DNS-label names from the validated `arc_lanes` configuration.
This bounded inventory uses the existing change/heartbeat write gate, with no
extra Firestore writes. Fleet totals require a consistent inventory and one
fresh snapshot per configured lane, including lanes that never published or
whose documents have been removed by TTL. During producer rollout, older
snapshots without inventory remain visible as individual Shuttlebay lanes but
cannot establish complete fleet totals; Bridge and Agents report unavailable
until the current producer contract arrives. Homelab owns producer delivery.

`orchestrator.yml`'s whole schema is:

```yaml
version: 1
server:
  metrics_addr: 127.0.0.1:8080 # optional, this is the default
  log_level: info # optional, this is the default
  log_format: text # optional, this is the default
kubernetes: # required; see "Kubernetes Jobs" below
  namespace: lcars-work
  # ...
arc_lanes: [] # optional, see above
```

Retired keys are rejected by name rather than ignored: `fleet` (the removed
Docker backend's host inventory, readiness gates, and scale-set placement
knobs), plus the scale-set manager's `github`, `registrations`, `scale_sets`,
and `server.state_path`. Startup and `--check-config` fail with an error naming
each key to delete, so a stale file can never be mistaken for live
configuration.

Sending the running process `SIGHUP` after replacing `orchestrator.yml` only
revalidates the file and logs whether a restart would accept it. Every value
the executor uses is captured at startup; applying a change needs a full
daemon restart.

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
launch. Health is sampled immediately on startup and then every 10 seconds,
but a sample is written to Firestore only when its content differs from the
last write or when the 60-second heartbeat is due. The console's Shuttlebay
panel receives each write through a server-sent stream backed by a Firestore
listener, not a poll, and stops presenting a snapshot as live after three
minutes (three heartbeats, also the document's TTL) without one. It reports only generic worker health: readiness, draining,
configured `max_concurrent` capacity, and an unfinished-Job count when the
Job inventory can be read. It has no pipeline, repository, provider,
credential, or individual-run data -- queue lifecycle counts (queued,
claimed, running, and outcomes) remain the console's authoritative
orchestrator Run records, not autoscaler telemetry.

The scale-set runtime this process used to also run published one additional
document per scale set to the same collection (`schemaVersion: 1`); that
publication was retired along with the scale-set code itself. The console
ignores that retired shape and reads only current ARC lane and direct-executor
records, with the shared three-minute staleness window. GitHub Actions runner
capacity and direct agent Job occupancy are displayed separately.

## Queue executor (direct-mode runners)

Server-dispatched work: a goroutine that polls the console's `POST
/api/work/v1/runs/claim` every 15 seconds while it has capacity and, on a
successful claim, launches one direct-mode runner Job (not GitHub-registered,
one-shot). The console routes every admitted run through this one
server-authoritative executor; the run's pipeline selects only its provider
adapter after the queue has claimed it. Its environment is:

```sh
LCARS_CONSOLE_URL=https://lcars.jlapenna.net
LCARS_WORK_AUDIENCE=agent-lcars-work
GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/telemetry-writer.json
LCARS_QUEUE_RUNNER_IMAGE=registry.example.com/homelab-runner:jit-node24
```

The trusted autoscaler environment may set `LCARS_WORKER_POLICY_PROVIDERS` to a
comma-separated subset of `claude,codex,opencode`, only after artifact-matched
qualification and specific activation approval. Empty or unset is disabled.
The executor validates and snapshots this selector before startup, then
explicitly forwards it to every worker Job, including the empty value so image
defaults cannot enable it. Run content cannot choose it. Changes require
restarting the executor and affect newly created Jobs; existing attempts retain
their launch configuration. See
[worker policy rollout](../../docs/worker-policy-rollout.md) for gates and rollback.

The poller starts only after the Kubernetes preflight below passes, then sends
a claim body containing only its runner identity. The server derives
claimable pipelines from the authenticated `work.executor` grant; no
autoscaler-local pipeline allowlist exists.

Admission is provider-aware. The server selects the FIFO head of the granted
pipeline with the fewest live claimed runs; provider-head age breaks occupancy
ties. This keeps a busy provider from taking the next released fleet slot while
another granted provider has fewer live claims. OpenCode is serialized because
its sessions share the local inference backend, and Codex is serialized because
its global subscription credential lease admits one session. Claude remains
bounded by `max_concurrent` and cluster capacity. The claim request cannot select pipelines or
change these server-owned limits.

This process has nothing else to run: an unconfigured queue executor (an
absent `LCARS_CONSOLE_URL`, or any required value missing) fails startup and
`--check-config` outright rather than running forever as a silent no-op.

### Kubernetes Jobs

The required top-level `kubernetes` section configures the backend. The
singleton controller uses the standard Kubernetes Go client; `kubeconfig`
selects a restricted external credential, and an omitted path uses in-cluster
ServiceAccount authentication.

```yaml
kubernetes:
  namespace: lcars-work
  kubeconfig: /run/secrets/queue-kubeconfig
  credentials_secret: lcars-runner-credentials
  service_account: lcars-direct-runner
  max_concurrent: 5
  node_selector:
    homelab.jlapenna.net/queue-runner: 'true'
  requests: { cpu: '2', memory: 6Gi, ephemeral-storage: 24Gi }
  limits: { cpu: '2', memory: 6Gi, ephemeral-storage: 24Gi }
```

The deployment owns namespace, RBAC, node labels/readiness taints, Secret values,
and resource sizing. The example budgets are provisional for rollout, not
measured direct-runner quantiles or binary defaults; choose burst limits
conservatively and measure pods before tightening them. The controller requires namespace Jobs
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
it. Startup and normal poll ticks recover eligible incomplete handoffs on the
same Job. Each bounded conflict retry reads fresh state and validates the
original UID, run, runner, generation-1 suspended spec, owned immutable token,
and live run/lease through the read-only Work brief route. Previously executed,
re-suspended, deleting or mismatched Jobs are never resumed. An already
unsuspended Job is an idempotent success. An ambiguous create reads that same
name rather than allocating a replacement. Jobs use `restartPolicy: Never`,
`backoffLimit: 0`, `podReplacementPolicy: Failed`, and fail on disruption.
Kubernetes does not promise exactly-once process execution under every node
failure; Work API authentication, completion fencing and provider credential
leases remain authoritative. Jobs have a two-hour wall-clock deadline including scheduling and image pulls,
which bounds infrastructure launch waits independently of worker heartbeat
renewal or the normal 80-minute agent budget. They retain
terminated pod logs for a day through the TTL controller, bounded to five
completed Jobs per configured capacity slot. The same garbage-collection
sweep deletes a suspended shell older than the two-hour lease window -- one
left when the controller died between creating a Job and its run-token
Secret, which would otherwise hold a `max_concurrent` slot forever -- with
UID/resourceVersion preconditions; running Jobs are never removed. The sweep
runs at startup and every 15 minutes off the claim path (single-flight,
30-second deadline), and is a local Kubernetes API list, never a Work API
call.

A full process restart is required for backend, credentials, topology or
resource configuration changes. `--check-config` performs the environment
checks and the read-only Kubernetes preflight described above.

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

Provider credentials stay behind the direct-runner adapter boundary: each
Claude or OpenCode pod projects only its own key from the credential Secret
as a read-only file, never an environment value; Codex receives no provider
key and uses the run-token-authenticated Console broker for its repository
auth.json. The Secret's `opencode-llm-api-key` must hold the LiteLLM virtual
key (`OPENCODE_LLM_API_KEY`). The direct adapter
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
`LCARS_CONSOLE_URL`/`LCARS_WORK_AUDIENCE` value above, and the `kubernetes`
stanza, is read once at process startup inside `runOrchestrator` and closed
over by the poller goroutine for its whole lifetime. Changing any of them, or
turning the queue executor on or off, needs a full daemon restart.

`LCARS_QUEUE_RUNNER_IMAGE` is the one container image reference every
direct-mode run launches, whichever pipeline (Claude, Codex, or OpenCode)
claimed it. It has no fleet-named default: this is deployment-specific
registry/tag knowledge the autoscaler cannot infer, so it is required for
queue-executor startup and a missing value fails boot, naming the variable.

Each Job uses `imagePullPolicy: Always`, so a launch follows the configured
tag as soon as a new runner image is promoted; there is no background refresh.

### Readiness and claim outcomes

The metrics endpoint exposes the queue worker's own health:

- `github_runner_autoscaler_queue_executor_ready` is `1` only after the
  queue executor has all required deployment configuration, a claim-token
  source, and a passing Kubernetes preflight; it is `0` when disabled or
  misconfigured.
- `github_runner_autoscaler_queue_executor_state{state}` is a one-hot state
  (`disabled`, `misconfigured`, or `ready`). An absent `LCARS_CONSOLE_URL`
  is disabled; a console URL with a missing required credential is
  misconfigured.
- `github_runner_autoscaler_queue_executor_polls_total{outcome}` separates a
  healthy empty queue (`idle_204` or `idle_empty`) from `poll_error` and the
  intentional `draining` skip.
- `github_runner_autoscaler_queue_executor_claims_total{pipeline}` counts valid claims by provider pipeline
  returned by the server. `github_runner_autoscaler_queue_executor_launches_total{outcome}`
  then records whether that claim launched a direct runner (`success` or
  `error`). A launch error therefore remains visible as a successful claim
  followed by a failed launch, rather than looking like an idle poll.

The existing v2 `runner-status` document carries an additive `claims` sample
for Shuttlebay. It differences these same three provider counters over an
exact `windowStart`–`windowEnd` interval, bounded to 15 minutes and 92 samples.
The initial baseline, a metric error, counter reset, or gap beyond the status
TTL is unavailable; a restart never invents a full preceding window. Changed
counts publish immediately and unchanged counts follow the normal heartbeat.
This is successful-claim throughput before launch, not provider execution or
completed functionality. Durable cooldowns and provider queue eligibility are
read separately from the orchestrator in a bounded, read-only transaction.

### Failed launches and pausing

**A failed launch leaves the run claimed on the control plane.** There is no
callback here to un-claim it. An eligible original never-started Job with its
owned immutable credential and a live run/lease is retried at startup and
on normal 15-second poll ticks. Recovery is single-flight, has a 20-second
sweep deadline, and runs off the reservation/claim path. The one-Pending
admission gate still blocks another claim until placement; recovery does not
mint a new run, Job or credential.

If startup cannot safely complete (for example, the credential is missing or
the run/lease fence refuses it), ordinary lease-expiry recovery remains the
backstop. After the claim lease expires (`LEASE_MS`, 2h), the run settles to
`lost`; its `queue.state` stays `claimed`. The orchestrator's bounded auto-retry
(`MAX_AUTO_RETRIES`, then parked) mints a fresh queue-executor run for the same
task, which a later poll claims. These cases may still cost a lease window;
an already executed attempt is never restarted to avoid that wait.

**`SIGUSR1` pauses the queue poller from claiming.** The signal toggles an
in-process flag the poller checks before every claim call and before starting
a recovery sweep: the first `SIGUSR1` pauses both, a second resumes them.
An already running bounded sweep may finish. This is a separate, in-memory
switch from the `queue.state` machine above: it does not cancel running Jobs
or settle or un-claim existing runs. Nothing else in this repo touches it. A claim minted moments
before this instance is replaced would just be another launch failure to
recover from (see above), so pausing before a redeploy avoids that rather
than preventing it.

### Delivering the claude CLI's own credential

`kubernetesQueue.job` (`queue_kubernetes.go`) sets `RUNNER_MODE`,
`LCARS_RUN_ID`, `LCARS_CONSOLE_URL`, and `LCARS_RUN_TOKEN` (from the per-run
Secret) on the worker, and projects the credential Secret's
`telemetry-writer.json` plus, for Claude, `claude-code-oauth-token` -- a
plain-text file holding the current `CLAUDE_CODE_OAUTH_TOKEN` value, the
`claude` CLI's own subscription credential -- read-only under
`/run/secrets`. `direct-runner.sh` reads that file and exports it as
`CLAUDE_CODE_OAUTH_TOKEN` into its own process environment immediately before
invoking `claude` (`claude` reads it straight from its process environment; no
flag or file path is accepted directly). It is deliberately a file, not a
Pod environment value, so it is never part of the Job or Pod spec.

OpenCode's runner-local loopback proxy observes LiteLLM's selected deployment
header after each response, maps it through the same virtual-key-authorized
`/model/info` endpoint, and persists only the bounded physical model identifier
beside the requested route. Runner hosts never contact llama-swap directly.

**Placing the secret's value in the credential Secret is a maintainer-gated
deployment action this repo's own code cannot perform**: the homelab
encrypted secret store (`secrets-cli` skill) owns the value. Not a Terraform
change, not a new IAM grant, and not something any workflow in this repo
performs. See `docs/deployment-boundary.md`'s "Queue executor routing" section
for the ownership boundary.

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
per-run directory. A retained Job's Pod therefore holds neither the
subscription credential nor its session transcript.

Direct Codex requires the separately reviewed,
repository-prefix-preserving runtime grant on `agent-lcars-codex-auth` and a
single-run canary before activation. This repository does not make that IAM
change; queue readiness does not bypass the broker's lease and repository
authorization checks.

## Deployment

The actual runtime config (`orchestrator.yml`: the `kubernetes` stanza and
ARC lane inventory) and the Ansible playbook that deploys this are owned by
[`jlapenna/homelab`](https://github.com/jlapenna/homelab)
(`github-runner-autoscaler/`), which pulls the images this repo's CI builds
and publishes rather than building from source itself -- see that repo for
operational docs (secrets, fleet topology).

Migrated from `jlapenna/homelab` -- see
[agent-lcars#52](https://github.com/jlapenna/agent-lcars/issues/52).
