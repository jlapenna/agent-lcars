# Repository-owned jobs

## Production design

Repositories own `.lcars/jobs/<name>/job.yaml` and `recipe.yaml`. A job is a
bounded, unattended operation with explicit inputs and a verifiable result.
Interactive skills, continuously running services and arbitrary agent sessions
remain their existing kinds of capability. Goose executes recipes; LCARS owns
admission, scheduling, identity, cancellation, durable outcomes and visibility.

This design replaces the development SQLite controller. There is one execution
queue: native Work and QueueExecutor. Job configuration, admission reservations
and result artifacts live in the same Firestore database as Work; they do not
introduce another execution state machine or daemon.

## Source and configuration

The catalog reads regular blobs from an exact default-branch commit of a managed
repository. YAML is bounded and rejects aliases, duplicate keys and unknown
manifest fields. Invalid definitions remain visible with errors and cannot run.
Deleted definitions stop new admission. Source refresh failure is an error, not
permission to keep scheduling cached content. Existing admitted runs retain their
immutable source, input, profile and baseline snapshot.

Version 1 supports manual invocation and five-field cron with an explicit IANA
timezone, one attempt, one active occurrence and overlap=skip. UTC occurrence
identity distinguishes repeated DST minutes; nonexistent local minutes do not
run. The existing five-minute maintenance tick admits at most the latest due
minute in its five-minute window; older occurrences are never backfilled.
Explicit enablement establishes an activation floor. Publishing a
manifest does not enable it. Updating its execution definition disables it until
the operator re-enables the new digest.

Profiles are operator-owned configuration, never recipe-selected credentials or
tools. Each profile grants repositories, input scopes and an exact allocation.
The server checks the current grant on enablement, invocation and scheduled
admission. A recipe cannot install extensions, change model settings, nest jobs,
retry, or choose a shell command. The configured worker image supplies Goose and
the profile's tools. Runtime credentials/configuration remain Homelab-owned.

## Admission and lifecycle

A Firestore transaction reserves each manual request ID or schedule occurrence,
pins the definition and previous successful result, and acquires the job's
single-active-occurrence pointer. Concurrent admission either replays the same
receipt or records a skipped overlap. Changed parameters under an existing manual
request ID conflict. Reservations contain deterministic Work identity; an
interrupted mint is retried by the existing maintenance tick without duplicating
Work. Work uses the internal `goose` pipeline; public coding intake cannot forge
a job snapshot.

The native Run is authoritative for pending, claimed, running and terminal state.
QueueExecutor claims with its existing authenticated capability and receipt/lease
protocol. The worker fetches its pinned job brief using the run token. Completion
is token-fenced and accepted only while the native Run owns that occurrence.
Cancellation uses existing Work cancellation and QueueExecutor retirement. A lost
recipe run is terminal; there is no automatic rerun of potentially effectful work.
An operator may explicitly invoke a new occurrence after retirement is proven.

Result artifacts are bounded, validated server-side and durably staged before
settlement. A successful native completion binds their digest. Staged artifacts
alone never establish success or advance the baseline. Reconciliation advances
the baseline only from a matching successful native Run, then releases the job
pointer. Failed, incomplete, canceled, timed-out and lost runs preserve the prior
successful baseline. A changed comparison scope starts without an old baseline.

## Execution and resource contract

Requests equal enforced limits. Every complete allocation is at most 2 CPU,
6 GiB RAM and 40 GiB storage, with smaller lane bounds taking precedence. The
current direct-agent lane is 2 CPU / 6 GiB / 24 GiB. Setup, tools, process
descendants, credentials, image layers, caches, scratch and artifacts are counted
together. No accelerator or second host contributes capacity.

Goose is installed, versioned and published in the normal LCARS runner image,
using `goose-version` and checksum-verified Linux release artifacts for amd64
and arm64. Native QueueExecutor launches the same single direct-runner container
and normal resource envelope used by the supported stack. There is no separate
Goose image, bootstrap container, storage receipt or scheduler.

The direct runner performs its existing activation retry, startup heartbeat,
periodic heartbeat and failure settlement before invoking the recipe adapter.
The adapter checks the admitted CPU/memory allocation, runs Goose once, forwards
cancellation, bounds output and reports through the token-fenced recipe endpoint.
Native Queue capacity admission, storage accounting and retirement remain the
owners of resource enforcement. A failed capped run remains failed.

The adapter requests Goose's JSON machine envelope, requires completed status,
and validates only the final assistant result. Intermediate tool output cannot
be mistaken for success. Provider credentials use the runner's existing projected
Secret mechanism. The Goose child receives only the configured provider environment;
this is the same trusted single-container execution boundary as other runtimes.
The adapter copies configuration into a private `GOOSE_PATH_ROOT` and removes that
private state after completion. Profiles must configure the intended tools and model;
their names alone grant no capabilities.

## Operator surface and rollout

The authenticated Jobs surface lists definitions, source errors, enabled state,
schedule/timezone, resources, latest occurrence and baseline. Operators can
refresh, enable/disable a reviewed digest, invoke a manual occurrence, inspect
artifacts and follow the native Work link for cancellation and execution detail.
API authorization is enforced server-side independently of the UI.

The first consumer is jclaw's report-only weekly security audit. Its existing
OpenClaw schedule remains authoritative until a separate activation procedure:
qualify a real manual run, cancellation, worker loss/recovery and a scheduled
occurrence; verify artifacts and baseline behavior; disable the old named audit;
enable the reviewed LCARS definition. Rollback disables new LCARS admission,
retires active allocations and restores the previous scheduler only after
termination is established. Source implementation does not assert deployed
qualification.

## Local acceptance

Protect transactional replay and overlap, interrupted-mint recovery, current
grant checks, immutable snapshots, exact-success baseline advancement, invalid
source removal, timezone boundaries, canceled/lost completion fencing and real
Goose envelope parsing. Exercise the production service with deterministic
in-memory ports and the Firestore transaction adapter against its emulator.
Typecheck/build the console and verify the worker/QueueExecutor contract under
enforced local caps. Live scans, deployments, PR updates and code submission are
outside this local implementation task.

## Configuration and operation

`AGENT_LCARS_JOB_PROFILES` is a JSON array of operator-owned profiles. Each entry
names `name`, allowed `repositories`, allowed LCARS `principals`, exact
`allocation` (`cpu`, `memory`, `storage`) and approved `inputSets`. Input sets are
exact string maps; the job cannot widen them at invocation. The operator and
executor Work grants must explicitly include `goose`. Public coding intake still
accepts only coding pipelines; Goose is selected by repository recipe admission.

A receipt-backed QueueExecutor pool uses its normal configured runner image and
resources. Its whole-job allocation must match the execution profile. The existing
runner credential Secret supplies `goose-environment.json` (a string-valued map of
provider environment variables) and `goose-config.yaml` (the operator-owned Goose
configuration). Version 1 supports one shared Goose tool/model environment across
the fleet; profiles narrow repository/principal/input admission, not tool authority.
Do not add model credentials to repository recipes. The image publication lifecycle
is the existing supported stack lifecycle; this local change does not publish it.

To qualify a candidate runtime, install the pinned Goose release with
`install-goose-release.sh`, then run `node --test runtime/goose-job.integration.test.mjs`
from the runner-image directory inside the supported worker allocation with the
fixture credentials mounted as documented by that test. The fixture exercises the
real CLI and bootstrap without contacting a paid provider or scanning a network.
A real audit and schedule cutover remain deployment acceptance, not a claim made by
the transport fixture.

The authenticated `/jobs` screen uses these Work API endpoints:

- `POST /api/work/v1/jobs/refresh` with a managed `repository`.
- `POST /api/work/v1/jobs/{id}/enable` with the reviewed `digest` and `enabled`.
- `POST /api/work/v1/jobs/{id}/invoke` with that `digest` and a stable `requestId`.
- `GET /api/work/v1/jobs/occurrences/{id}` for the pinned occurrence and artifacts.

Refresh is required before admitting from a catalog older than ten minutes.
Source failures disable admission until a successful refresh and explicit
enablement. Disable stops new occurrences; use native Work cancellation to stop
an admitted occurrence. A lost occurrence is failed and never automatically
retried. An unreleased retirement keeps the job occupied until the existing
capacity recovery protocol establishes physical termination.
