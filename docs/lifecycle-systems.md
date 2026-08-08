# Operational ownership and runbooks: the five lifecycle systems

[#645](https://github.com/jlapenna/agent-lcars/issues/645) decided to build
the agent dispatch lifecycle as five operational systems — Dispatch
controller, Runner platform, Worker runtime, Outcome finalizer, and
Projector/read model — instead of ten tangled concerns under one "dispatch"
label. This document is that issue's Phase 6 checkbox, "Document operational
ownership and runbooks for all five systems." It answers one question per
system: when this breaks, whose problem is it, and what do you check first.

The dispatch controller has an explicit migration switch:
`DISPATCH_STORAGE_MODE=shadow` projects the issue-comment ledger into
Firestore for comparison, while `authority` makes the Firestore task
aggregate authoritative under a compare-and-swap lease. In authority mode
the pinned `<!-- agent-lcars:dispatch-ledger:v1 -->` comment remains a
human-readable compatibility projection, but a forged comment cannot change
controller truth. Worker preflight also reads the exact Firestore aggregate
in authority mode, using a short-lived WIF token minted before any untrusted
agent code runs; shadow/off preflight retains the comment reader for rollback
compatibility. `off` is the rollback position before authority cutover.

Two seams are load-bearing enough to read before anything else:

- **The compatibility comment is forgeable by the agents it controls.**
  `loadLedger` authenticates the ledger by comment _author_ — it must be
  posted by the workflow identity and be of type `Bot`
  (`github-api.ts:815-822`). `saveLedger` updates it with a `PATCH`
  (`github-api.ts:846-860`). **Editing a GitHub comment does not change its
  author.** Any credential carrying `issues: write` — which an agent whose
  job includes commenting on an issue necessarily holds — can rewrite the
  ledger while the author check keeps passing, because nothing about
  authorship changed. This is why `apps/dispatch-broker/src/storage/port.ts`
  exists (see its own header for the full finding): in authority mode it
  provides state the controlled code cannot write, and no
  credential-scoping fix closes the gap, because the capability that lets an
  agent do its job is the same capability that lets it rewrite the ledger.
- **A GitHub concurrency group is a lossy queue, not a throughput limiter.**
  At most one run per group may be _pending_; a newer arrival evicts the
  older one outright, and `cancel-in-progress: false` protects only the
  _running_ run. `dispatch-reconcile.yml` is the safety net for lost
  intents, but it works by re-deriving desired state from the issue's
  current labels — so an intent whose labels have since changed leaves
  nothing for it to reconcile. This is not hypothetical; it is what happened
  today (see the Dispatch controller worked incident below).

The Runner platform section below has its own seam, named where it belongs:
its actual runtime configuration lives in a different repository entirely,
so an agent-lcars-only investigation of a runner-platform outage can
confirm the symptom but not the cause.

## Symptom → owning system

The fast path. Match what you're looking at, then go to that system's
section.

| What you observe                                                                                                                                                                        | Owning system                                                                                                                                                              | Look here first                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue carries the right `agent:*` label but nothing dispatches; `agent-router.yml` runs show `cancelled` with **zero steps executed**                                                   | Dispatch controller                                                                                                                                                        | The run's own step list (0 steps = evicted, not failed) — see worked incident below                                                             |
| Issue carries the right `agent:*` label but nothing dispatches, and `gh run list --workflow agent-router.yml` shows **no run at all** for the event                                     | Dispatch controller (event-trigger path) — **not** Runner platform: runner selection happens only after GitHub creates the run, so an absent run was never queued anywhere | Whether the event reached GitHub and matched `agent-router.yml`'s trigger filters at all (webhook delivery, event type, label)                  |
| `agent-router.yml` jobs sit **queued**, never even starting                                                                                                                             | Runner platform                                                                                                                                                            | `gh api repos/<owner>/<repo>/actions/runners` for a runner carrying `${{ vars.CONTROL_PLANE_RUNNER_LABEL }}`                                    |
| `dispatch-reconcile.yml` fails invoking `/api/control-plane/reconcile`, or the endpoint returns 401/5xx                                                                                 | Dispatch controller (hosted reconciliation)                                                                                                                                | The GitHub-hosted job log, then App Hosting logs for OIDC rejection, discovery failure, or per-candidate dispatch failure                       |
| A worker (`claude.yml`/`codex.yml`/`opencode.yml`) job sits **queued**, never starting                                                                                                  | Runner platform                                                                                                                                                            | Same check, against `${{ vars.AGENT_RUNNER_LABEL }}`                                                                                            |
| A published action (`run-dispatch-canary`, `rerun-infra-killed-runs`, `dispatch-broker`) fails immediately with a load-time error (e.g. `ERR_MODULE_NOT_FOUND`) in its **own** step log | Dispatch controller                                                                                                                                                        | The failing step's raw log, before assuming an authorization/ordering bug                                                                       |
| A scheduled workflow (canary or otherwise) has been failing quietly and nobody noticed                                                                                                  | _No system owned this until `dispatch-canary.yml` specifically_                                                                                                            | `.github/actions/canary-alert` — open PR [#707](https://github.com/jlapenna/agent-lcars/pull/707), not yet merged; see its own subsection below |
| Worker fails during checkout, App-token mint, tool setup, or telemetry sidecar startup — before the agent itself runs                                                                   | Worker runtime (bootstrap phase)                                                                                                                                           | The job's steps before "Run Claude Code" / "Run Codex" / "Run OpenCode"                                                                         |
| Worker fails with a provider/model error (rate limit, graph allocation, auth)                                                                                                           | Worker runtime (provider admission/execution)                                                                                                                              | The agent step's own log; `opencode-model-canary.yml`'s last scheduled result                                                                   |
| Agent process exits 0, but no PR/comment/label shows up, or an unrelated artifact gets credited                                                                                         | Outcome finalizer                                                                                                                                                          | `.github/actions/verify-deliverable`'s log line naming which clause (0, a–e) it evaluated                                                       |
| Deliverable clearly exists, but the issue never got a comment, `status:needs-human`, or maintainer assignment                                                                           | Outcome finalizer / Projector (reporting) — see the seam note in that section                                                                                              | `.github/actions/report-failure`'s log                                                                                                          |
| GitHub state (labels, comments, PR) is correct but the console shows something stale or wrong                                                                                           | Projector/read model                                                                                                                                                       | `apps/console/src/lib/dispatch-ledger.ts`'s parse of the same ledger comment                                                                    |
| Ledger stuck on the same revision for a long time, no anomaly recorded                                                                                                                  | Dispatch controller (reconciliation)                                                                                                                                       | `dispatch-reconcile.yml`'s GitHub-hosted invocation and the App Hosting endpoint logs                                                           |

## 1. Dispatch controller

**Owns:** accepted intent, authorization decisions, task ordering, attempt
identity (`g<generation>:<intentId>`, derived from the ledger, not minted —
see the issue's own design note on why), attempt-to-workflow-run binding,
and the dispatch ledger itself.

**Code:**

- `apps/dispatch-broker/src/main.ts` — orchestration: `normalize`,
  `broker`, `preflight`, `completionCallback`, `scanReconcile`, plus the
  reconciliation functions `reconcileActive`, `trackMissingRun`,
  `trackStuckRun`, `reconcileLedger`.
- `apps/dispatch-broker/src/broker.ts` — the module's public re-export
  surface over the extracted modules below (kept as one-way imports
  deliberately, to avoid an ESM temporal-dead-zone cycle in the control
  plane).
- `apps/dispatch-broker/src/modules/authorization.ts`, `intent.ts`,
  `scheduler.ts`, `ledger-core.ts` — the Phase 2 extraction: pure,
  independently testable state-transition modules.
- `apps/dispatch-broker/src/github-api.ts` — GitHub REST transport,
  including `loadLedger`/`saveLedger` (the ledger's read/write path) and
  `findConflictingRouterRun`/`verifyBrokerConcurrency` (the concurrency
  corroboration logic behind [#545](https://github.com/jlapenna/agent-lcars/issues/545),
  closed).
- `apps/dispatch-broker/src/normalize.ts` — event-to-signal normalization.
- `libs/dispatch-reconcile/src/` — host-independent discovery, pagination,
  deduplication, bounded dispatch, and scan-result contract shared by the
  Action fallback and hosted backend.
- `apps/console/src/app/api/control-plane/reconcile/route.ts` — hosted scan
  endpoint; accepts only GitHub Actions OIDC from this repository's
  `dispatch-reconcile.yml` on `main`.
- `libs/dispatch-contracts/src/` — the shared schema every consumer now
  imports instead of hand-mirroring: `ledger.ts` (ledger shape/marker),
  `marker.ts` (the `[dispatch:g<n>:<id>]` run-title marker and the
  attempt-claim marker), `pipelines.ts` (pipeline/bot identity registry),
  `failure.ts` (owning-system/phase/reason/retry-disposition vocabulary),
  `projection.ts`, `quick-task.ts`.
- `.github/actions/dispatch-broker` — the composite wrapping the esbuild
  bundle at `dist/main.mjs` (source: `apps/dispatch-broker/src/main.ts`).
- `.github/workflows/agent-router.yml` — the `normalize` and `broker` jobs,
  both `runs-on: ${{ vars.CONTROL_PLANE_RUNNER_LABEL }}`.
- `.github/workflows/dispatch-reconcile.yml` — a GitHub-hosted scheduler
  invokes the App Hosting endpoint every 30 minutes. Its manual
  `action-fallback` transport retains the prior self-hosted composite-action
  scan during soak.
- `.github/workflows/dispatch-canary.yml` +
  `.github/workflows/agent-dispatch-canary.yml` +
  `.github/actions/run-dispatch-canary` — the controller's own end-to-end
  canary (structurally incapable of touching self-hosted infra or a paid
  model; runs on `ubuntu-latest`).

**What breaking looks like (worked incident — PR
[#703](https://github.com/jlapenna/agent-lcars/pull/703)):** the `normalize`
job in `agent-router.yml` held a repository-wide concurrency group
(`<repo>-control-plane-normalize`), meant only to keep load off the small
control-plane pool. A GitHub concurrency group permits at most one _pending_
run; a newer arrival evicts the older one, and `cancel-in-progress: false`
protects only the run already executing. Because the group was
repository-wide, any two router events landing close together anywhere in
the repo dropped the older one — cancelled before its first step, no ledger
comment, no anomaly, no trace the intent ever existed. Across a multi-hour
window, essentially every router run was `cancelled` with zero steps
executed. `dispatch-reconcile.yml` eventually re-drives an issue that still
carries its labels, which is why this presented as mysterious dispatch
latency rather than an obvious hole — the reconciler cannot repair what left
no trace, because it re-derives from labels, and an intent whose labels have
since changed is simply gone. The fix removed the group entirely: normalize
is read-only and capped at two minutes, and the runner pool's own
wait-for-a-free-runner behavior already supplies the right backpressure. The
serialization that actually matters — the `broker` job's per-task
concurrency group — was untouched.

A second, unrelated way this system breaks: PR
[#700](https://github.com/jlapenna/agent-lcars/pull/700) found that after
the broker moved to `apps/dispatch-broker/src/*.ts`, two published actions
(`run-dispatch-canary`, `rerun-infra-killed-runs`) still imported the
deleted pre-move path and had been unable to load — `ERR_MODULE_NOT_FOUND`
in the action's own log — for 7 and 5 consecutive scheduled runs
respectively. This looks like "the broker didn't run" from the ledger's
point of view but is a packaging defect, not an authorization or ordering
bug; the giveaway is the load-time error appearing before any of the
broker's own logic executes.

**First three things to check:**

1. Read the ledger comment on the issue/PR itself (the
   `<!-- agent-lcars:dispatch-ledger:v1 -->` block) — `revision`, `sources`,
   `generations`, `anomalies`, `projection`. No comment, or a comment stuck
   on an old revision with no anomaly, is the first signal something
   upstream never landed.
2. `gh run list --workflow agent-router.yml` for the issue — a `cancelled`
   run with **zero steps executed** is a concurrency eviction (see the
   worked incident), not a real failure; a run that executed and then
   failed is a genuine error; **no run at all** is neither — runner
   selection happens only after GitHub creates the run, so an absent run
   means the event never reached this workflow in the first place, which
   is still this system's problem, not Runner platform's (see the symptom
   table).
3. If a published action is involved, read its own step log first —
   `ERR_MODULE_NOT_FOUND` or any other load-time error means the code never
   ran at all, which rules out an authorization/ordering explanation before
   you go looking for one.

**Who/what repairs it:** `dispatch-reconcile.yml` scans every open,
agent-labeled or agent-fleet-assigned issue/PR every 30 minutes and
re-drives a generation stuck `dispatching`/`dispatch-unknown` through the
same per-issue serialized `agent-router.yml` path every other trigger uses.
Past a bounded retry count it parks `status:needs-human` instead of retrying
forever. It **cannot** recover an intent whose labels changed after the
event that would have carried the real signal was lost — that class needs a
human to re-apply the correct label or use the console's retrigger action.
The scheduled scan runs through App Hosting from `ubuntu-latest`, so a
`CONTROL_PLANE_RUNNER_LABEL` outage can delay the per-issue router repairs
but cannot prevent their durable `workflow_dispatch` runs from being
created. During hosted-path soak, a maintainer can select
`action-fallback` on a manual `dispatch-reconcile.yml` run to execute the
previous composite-action scanner.

## 2. Runner platform

**Owns:** compute capacity — runner creation, placement, readiness, queue
pressure, and runner loss — across the shared Docker host pool.

**Code:**

- `apps/runner-autoscaler/*.go` — the orchestrator process:
  `orchestrator.go` (scale-set listener supervision), `scaler.go`
  (placement), `fleet_coordinator.go`, `checkpoint.go` (quiesce/restart
  state), `hosts.go`, `runner_status.go`, `metrics.go`, `config.go`,
  `github_http.go`, `github_app_token.go`.
- `apps/runner-autoscaler/runner-image/` — the JIT worker image
  (`Dockerfile`, `entrypoint.sh`, `externals-health.sh`) — this is also
  where `apps/telemetry-watcher`'s bundle gets baked in, built fresh from
  this repo's own `main` at image-build time — the one sanctioned
  **same-repo** image-build integration point, not a cross-repo one (see
  `AGENTS.md`).
- `apps/runner-autoscaler/control-plane-image/Dockerfile` — a separate
  image for the control-plane pool specifically.
- `apps/runner-autoscaler/README.md` — build/test, live-reload (`SIGHUP`),
  quiesce-vs-drain (`SIGTERM` vs `SIGUSR1`), and checkpoint semantics; read
  it before touching a running instance.

**Its runtime configuration does not live in this repo.** `orchestrator.yml`
— fleet host inventory, GitHub App credentials, and the scale-set
definitions that decide which label(s) get a listener at all — is owned by
`jlapenna/homelab`'s `github-runner-autoscaler/` directory, deployed by that
repo's Ansible playbook. `docs/onboarding-autoscaler.md` documents the
split in detail. agent-lcars only _publishes the images_ homelab pulls and
_names the labels_ its own workflows expect (`AGENT_RUNNER_LABEL`,
`CONTROL_PLANE_RUNNER_LABEL`, `DEFAULT_RUNNER_LABEL`, `CI_RUNNER_LABEL`,
`BUILD_RUNNER_LABEL` — see `docs/deployment-boundary.md` §3). Whether
anything is actually listening for a given label is entirely homelab's
question to answer.

**What breaking looks like (worked incident, today):**
`homelab-autoscale-lcars-control` was added to homelab's `orchestrator.yml`
and `CONTROL_PLANE_RUNNER_LABEL` was repointed at it, but the
`runner-autoscaler` container was never restarted (and never sent
`SIGHUP` — see the README's live-reload section), so the _running process_
never loaded a listener for that label. Every `agent-router.yml` and, at the
time, `dispatch-reconcile.yml` job requesting that label queued forever and
was eventually evicted. Total outage: roughly 20 hours. #736 subsequently
moved the scheduled scan to the existing App Hosting backend, invoked from
`ubuntu-latest`, specifically so the repair trigger no longer shares this
failure domain. Nothing alerted. The
reason nothing alerted is visible in the code:
`github_runner_autoscaler_listener_up{scale_set}` (`apps/runner-autoscaler/metrics.go`)
is a gauge keyed per scale set — a scale set that was never loaded into the
running process has **no time series at all**, so a threshold alert on it
has nothing to evaluate. The listener-down alert (owned by homelab, not
verifiable from this repo) only watches listeners that exist.

**First three things to check:**

1. `gh api repos/<owner>/<repo>/actions/runners` — is there a registered
   runner carrying the exact label a stuck job's `runs-on:` names? None
   means the platform never provisioned one for that label, regardless of
   what config says it should.
2. On homelab: `docker logs runner-autoscaler | grep -oE "scale_set=[a-z-]+" | sort -u`
   — the scale sets the **running process** actually serves (its structured
   logs key on `scale_set`, confirmed in `orchestrator.go`). Compare against
   the label the stuck job wants and against homelab's current
   `orchestrator.yml`. Config and the running process can disagree
   indefinitely after an edit with no reload.
3. Ask whether `orchestrator.yml` was edited without a following `SIGHUP`
   (live reload) or container restart — a config edit alone changes
   nothing until one of those happens.

**Who/what repairs it:**

- A config change with no reload/restart: nothing in agent-lcars can fix
  this. It is entirely a homelab-side operation, and this repo cannot even
  observe it directly — see the seam below.
- Runner loss or a crashed process: the orchestrator's own boot sweep and
  periodic sweep re-adopt existing containers from Docker labels (README's
  "Boot sweep and unreachable hosts"); no agent-lcars action needed.
- Genuine capacity exhaustion (every host hard-overloaded, fleet at its cap):
  a human, via homelab's fleet/host inventory and placement tuning.

**The seam, named plainly:** the runner platform's config lives in another
repository. An agent-lcars-only investigation can prove the _symptom_ (a
job stuck queued, a label with no matching runner in the GitHub API) but
cannot see the _cause_ — whether `orchestrator.yml` was ever edited, whether
the process was ever reloaded, or what the live process actually has
loaded. Closing this whole class of outage requires checking homelab, not
just agent-lcars.

## 3. Worker runtime

**Owns:** preparing the execution environment (bootstrap) and faithfully
invoking the requested agent/provider combination.

**Code:**

- `.github/workflows/claude.yml`, `codex.yml`, `opencode.yml` — one job
  each. **Not yet split into separate execute/finalize jobs** (Phase 3's
  "Split execute and finalize jobs" bullet is unstarted); bootstrap, the
  agent step, and the post-agent gates all run in the same job today. All
  three share the same sequence: checkout → snapshot enforcement scripts →
  authority-storage auth (authority mode only) → broker preflight → mint
  agent token → claim issue → agent setup → verify agent identity → prepare
  dispatch context → start telemetry sidecar → run the agent → run
  post-agent gates.
- `.github/actions/agent-setup`, `mint-agent-token`, `verify-agent-identity`,
  `prepare-agent-dispatch`, `setup-opencode`, `telemetry-start` — the shared
  bootstrap pieces (Phase 3's "replace duplicated Claude/Codex/OpenCode
  lifecycle scaffolding with one worker harness" bullet, done for bootstrap
  and post-agent gates; the harness is these shared composite actions plus
  `post-agent-gates.sh`, not yet a single first-class module).
- `.github/workflows/bootstrap-canary.yml` — proves the self-hosted
  bootstrap sequence (runner allocation, App-token mint, enforcement-script
  snapshot, telemetry sidecar WIF auth) on the real fleet without invoking a
  paid model.
- `.github/workflows/opencode-model-canary.yml` — an exact-model provider
  canary for OpenCode only. Claude and Codex do not get an equivalent: per
  the workflow's own header, neither `CLAUDE_CODE_OAUTH_TOKEN` nor
  `CODEX_AUTH_JSON` has an honest, cheap liveness check independent of
  actually invoking the real paid/subscription harness, which a canary is
  forbidden from doing. OpenCode's `homelab` provider is a plain
  OpenAI-compatible REST endpoint, so a direct completion call is a real,
  cheap, honest probe.

**Credential boundaries, concretely** (worker workflow, `claude.yml` as the
example — the other two lanes match): the agent step never receives
`github.token` — every dispatch-broker call in the job uses that credential
directly, so handing it to agent-authored code would let that code rewrite
the ledger or act as the controller, which is exactly what the ledger-forgery
finding above is about. The agent instead gets a separately minted Agent
LCARS App token (`mint-agent-token`) for its own claim/comment/push
identity, a distinct telemetry WIF credential (`telemetry-start`,
impersonating a write-only `telemetry-writer` service account), and,
optionally, `AGENT_CI_RERUN_TOKEN` — a classic PAT at `public_repo` scope
from the `jclaw-bot` machine account, not `github.token`, so the agent can
rerun its own failed CI without holding the control-plane credential (see
`docs/deployment-boundary.md`'s dedicated section on that token for why a
minted App token can't fill this role — it expires inside a long-running
opencode session).

**What breaking looks like:** two distinct failure shapes, and telling them
apart is the point of this system's phase boundary. A **bootstrap** failure
(App-token mint, checkout, tool setup, or the telemetry sidecar dying)
happens before the agent ever runs — it shows up as a failed step above
"Run Claude Code"/"Run Codex"/"Run OpenCode" in the job log, or as a red
`bootstrap-canary.yml` run. A **provider/agent execution** failure (a rate
limit, an OpenCode graph-allocation error, an auth rejection) happens inside
the agent step itself, or as a red `opencode-model-canary.yml` run. Neither
is a controller problem or a finalizer problem — a bootstrap failure still
reaches finalization and projection (worker-token minting failing is an
explicit acceptance scenario in #645), and a provider failure is bounded,
worker-owned retry, never controller-level retry.

**That "still reaches finalization" guarantee has a gap at the very start
of bootstrap.** Each worker's post-agent step runs
`bash "$RUNNER_TEMP/trusted-actions/post-agent-gates/post-agent-gates.sh"`
unconditionally (`if: always()`), but that script is written to
`$RUNNER_TEMP` only by the earlier "Snapshot post-agent enforcement
scripts" step (`.github/actions/snapshot-enforcement-scripts`), which in
turn depends on checkout having already succeeded (it's a local composite
action, resolvable only once the repo is on disk). If checkout or that
snapshot step itself fails, `post-agent-gates.sh` was never written, so the
`if: always()` step fails on a missing file instead of running
verify-deliverable/report-failure — no finalizer report reaches the issue.
"Return completion observation to the broker" doesn't cover this either:
it's also `uses: ./.github/actions/dispatch-broker`, a checkout-local
composite action GitHub Actions cannot resolve without a successful
checkout. So a failure in checkout or the enforcement-script snapshot — the
first two bootstrap steps in `claude.yml`/`codex.yml`/`opencode.yml` — is
the one bootstrap-failure shape that reaches neither finalization nor the
controller's completion callback; it surfaces only as a red job with no
comment, label, or ledger update.

**First three things to check:**

1. Which step failed: before or after the agent step itself? Before means
   bootstrap (Runner platform's job started fine, but something in
   checkout/token-mint/tool-setup didn't); at or after the agent step means
   provider/agent execution.
2. `bootstrap-canary.yml`'s and (for OpenCode) `opencode-model-canary.yml`'s
   most recent scheduled runs — a red canary before the real failure
   narrows it to "this lane's infra/provider was already unhealthy," not a
   one-off.
3. The agent step's own log for the provider's error text — this system's
   phase vocabulary (`provider_admission`, `provider_execution`,
   `bootstrap`, `agent_execution` in `libs/dispatch-contracts/src/failure.ts`)
   exists, but emission at every fallible transition is not yet complete
   (Phase 1's "emit the last known phase before every fallible transition"
   remains open per the issue's own tracking), so the raw log is still the
   most reliable source today.

**Who/what repairs it:** nothing automatically retries a worker-runtime
failure at this layer — provider retry is bounded and stays inside the
worker's own adapter, and a worker that fails bootstrap still reaches
finalization/reporting rather than being silently swallowed. Recurrence
across multiple dispatches is a human problem: a stale credential, a
provider outage, or a broken bootstrap step needs a maintainer, not a
reconciler.

## 4. Outcome finalizer

**Owns, in principle:** terminal attempt state and deliverable validity —
independent of the agent filesystem or work credential.

**What actually exists today is split across two places that don't yet
share a boundary**, and naming that split is more useful than pretending
it's already one system:

- **Deliverable validation** — `.github/actions/verify-deliverable/verify-deliverable.sh`,
  invoked directly from each worker workflow (`claude.yml`/`codex.yml`/
  `opencode.yml`) via `post-agent-gates.sh`. Five clauses, evaluated in
  order: clause 0 is exact evidence (an attempt-claim marker,
  `<!-- attempt-claim:<attempt-id> -->`, stamped on the specific PR/comment/
  review this run produced — see `libs/dispatch-contracts/src/marker.ts`'s
  `formatClaimMarker`); clauses (a)–(e) are inference-based fallbacks (a
  matching open/updated PR since the run started, the issue closing, a
  `status:needs-human` label appearing, an expected bot comment on a reply
  or runbook dispatch, or a PR review on a review dispatch). The inference
  path is explicitly kept until soak, per #645, not removed yet.
- **Execution-state classification** (`not_started`/`running`/`exited`/
  `timed_out`/`cancelled`/`lost`) — this is decided by the **controller's**
  own reconciliation code: `reconcileActive`, `trackMissingRun`,
  `trackStuckRun`, and `reconcileLedger`, all in
  `apps/dispatch-broker/src/main.ts`. A run cancelled or lost before
  finalize is terminalized by the same reconciler that repairs stuck
  intents, not by a dedicated finalizer reconciler. This is precisely the
  entanglement Phase 6's "give each of the five systems its own narrow
  reconciler" is supposed to end; it has not yet.

**What breaking looks like:** an agent process exits zero, but
`verify-deliverable` finds no clause satisfied — no attempt-claim marker, no
new/updated PR, no issue close, no label, no expected comment or review.
The job fails, and `report-failure` posts the visible failure (see the
Projector section — that step is also, awkwardly, part of today's reporting
path, not this system's). The inverse failure mode is what clause 0 exists
to close: before the attempt-claim marker shipped (#645 Phase 4), an
unrelated PR created by a shared bot identity, or a stale label from
earlier work, could satisfy an inference clause it shouldn't have —
`EXCLUDE_PR_AUTHOR` and the `STARTED_AT` time window are the (imperfect)
guards against that for the clauses that remain.

**First three things to check:**

1. `verify-deliverable`'s own log — it names which clause it evaluated and
   why each one did or didn't match; do not guess from the job's red/green
   status alone.
2. Whether the run actually produced the artifact you expect (a PR, a
   comment, a label) and whether that artifact carries the attempt-claim
   marker — if the artifact exists but lacks the marker and doesn't satisfy
   any inference clause either, that's a real gap, not a false negative.
3. If the failure is about execution state (cancelled/lost) rather than
   deliverable validity, check the ledger's `generations` entry directly —
   that classification comes from the controller's reconciliation code
   (`main.ts`), not from `verify-deliverable`.

**Who/what repairs it:** nothing automatically retries a failed
deliverable-validation gate — a `status:needs-human` label plus a
maintainer-facing comment from `report-failure` is the terminal state.
Post-agent redrive is explicitly disallowed until side-effect
reconciliation completes (#645's own "must not" list for this system);
today that boundary is enforced by convention (nothing wired to auto-redrive
exists), not by code that would stop one if it did.

## 5. Projector and read model

**Owns, in principle:** convergence of derived human-facing state — GitHub
comments, labels, assignees, reactions, and the console/read-model view —
from the controller's and finalizer's already-decided truth.

**Like the Outcome finalizer, this is currently three uncoordinated write
paths plus one read path, not one system:**

- **`apps/dispatch-broker/src/modules/projector.ts`** — the controller's own
  in-process projector module: `projectComment`, `projectNeedsHumanPark`,
  and `recordProjectionStatus` (which writes exactly one ledger field,
  `ledger.projection`). Its own header is explicit about the structural
  guarantee it does and doesn't have: it imports nothing from `broker.ts`
  that can mutate `generations`/`sources`/`control`, so no code path through
  it today reaches those fields — but that's a property a reviewer can
  verify by reading the import list, not an enforced impossibility.
- **`.github/actions/report-failure/report-failure.sh`** — invoked from
  inside the worker job itself (via `post-agent-gates.sh`), on the
  self-hosted runner, using the job's own token. Posts the failure comment,
  adds `status:needs-human`, and assigns the maintainer. This is a third,
  separate write path from the controller's own projector module above.
- **`apps/console/src/lib/backend-actions.ts`** — the console's own direct
  `octokit` writes: `postComment`, `clearNeedsHumanLabel`,
  `approveAndMergePr`, `reassignPipeline`, `retriggerIssue`, and Quick Task
  creation. `retriggerIssue` correctly delegates to `agent-router.yml`
  (Phase 1's routing goal, done for this one action). `reassignPipeline`
  does **not** — per the issue's own recorded finding, it is genuinely
  blocked: the broker has no label-writing capability of its own today
  (`removeIssueLabel` exists only for the dual-label self-heal), and the
  router has no "relabel, don't dispatch" input. Delegating it needs new
  controller capability, not just a console-side change.
- **`apps/console/src/lib/dispatch-ledger.ts`** — the read side. Parses the
  same ledger comment `github-api.ts` writes, now importing
  `@agent-lcars/dispatch-contracts` directly instead of a hand-mirrored copy
  (Phase 1's contract-publication work, landed in PR #679). Feeds
  `logical-work.ts`, `agent-activity.ts`, and `action-items.ts`, which is
  where the owning-system/phase/reason/retry-disposition fields from
  `libs/dispatch-contracts/src/failure.ts` (PR #681, merged) actually
  surface to a maintainer.

**What breaking looks like:** the deliverable and the outcome are correct,
but nothing visible reflects it — no comment, no label change, no console
update — because the specific write path involved failed independently of
the outcome it's supposed to report. The console showing stale or wrong
status while GitHub's own state is correct is the other shape: a read-model
staleness bug in `dispatch-ledger.ts` or its consumers, not a
write-path failure at all.

**First three things to check:**

1. Which of the three write paths should have fired for what you're
   missing — a worker-reported failure (`report-failure`), a
   controller-driven park/comment (`modules/projector.ts`), or a
   console-originated action (`backend-actions.ts`)? They fail
   independently and leave no shared trail.
2. If it's a console display issue, compare the raw ledger comment against
   what the console shows — a mismatch there is `dispatch-ledger.ts` or a
   downstream consumer, not a write-path failure at all.
3. If it's `reassignPipeline`, stop looking for a bug: it is a known,
   recorded gap (see above), not yet a controller capability.

**Who/what repairs it:** nothing today. Per #645's "must not" list, a
failed GitHub write must never change the underlying outcome, and none of
the three write paths above currently retries itself or gets retried by
another system. A stuck park or a missing comment needs a human to notice
and re-run the specific action (a console retry, a manual label/comment, or
re-running the worker's report step is not exposed as a standalone
operation today).

## The canary nobody heard, and what changed

The dispatch canary (`dispatch-canary.yml`) failed 7 consecutive scheduled
runs during the Runner platform outage described above, and `post-deploy-smoke.yml`
silently stopped alongside it. **There was no failure alerting anywhere in
`.github/workflows/` for it.** A human found it by hand.

PR [#707](https://github.com/jlapenna/agent-lcars/pull/707) — **open, not
yet merged as of this writing** — adds `.github/actions/canary-alert`,
called from `dispatch-canary.yml` with `if: always()`:

- **On failure:** opens (or comments on) a single tracked issue carrying
  `<!-- agent-lcars:canary-alert:v1 -->`, labelled `status:needs-human` and
  assigned to the maintainer. The comment records the failing run URL, a
  UTC timestamp, and a consecutive-failure count derived **live** from the
  canary workflow's own run history (walking conclusions most-recent-first
  until the first success) — deliberately not persisted state, because a
  state file is itself a thing that can silently stop being written.
- **On success:** closes that tracked issue with a recovery comment, if one
  is open. This auto-resolution is explicit in the PR description as a
  requirement, not a nicety — an alert that only ever opens becomes noise
  and gets ignored, which is the exact failure mode it exists to fix.
- Two properties are deliberate: the alert path runs on `ubuntu-latest`
  (same as `dispatch-canary.yml` itself), so it keeps working precisely
  when the self-hosted control plane is dead; and the alerting step is
  `continue-on-error: true`, so a transient API hiccup in the alert path
  itself can log loudly without ever flipping a healthy canary run red —
  and, since the canary's own step already fixed the job's real conclusion
  before this step runs, it can't turn a failing run green either.

Until this PR merges, this system remains exactly as exposed as it was
today: nothing pages on a dark canary, and only `dispatch-canary.yml`
specifically will be covered even after it does — no other scheduled
workflow in this repo gets the same treatment yet.

## Canary coverage today, honestly

#645 asks for one end-to-end contract canary per system (Phase 6). What
exists on `main` right now:

| System               | Canary                                                                                | Status                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Dispatch controller  | `dispatch-canary.yml` / `agent-dispatch-canary.yml`                                   | Exists                                                                                                                                       |
| Runner platform      | —                                                                                     | No dedicated canary; exercised indirectly as a side effect of `bootstrap-canary.yml` allocating a real runner, not verified in its own right |
| Worker runtime       | `bootstrap-canary.yml` (all three lanes), `opencode-model-canary.yml` (OpenCode only) | Exists, partial (no Claude/Codex model canary — see Worker runtime section for why)                                                          |
| Outcome finalizer    | —                                                                                     | None                                                                                                                                         |
| Projector/read model | —                                                                                     | None                                                                                                                                         |

## Related docs

- [`docs/deployment-boundary.md`](deployment-boundary.md) — repo variables
  (including the runner-label variables this document references),
  `AGENT_CI_RERUN_TOKEN`'s exact scope, and why it's a separate machine
  identity rather than a scoped `github.token`.
- [`docs/onboarding-autoscaler.md`](onboarding-autoscaler.md) — the
  agent-lcars/homelab split for the Runner platform in full, and how to add
  a new registration.
- [`docs/published-actions.md`](published-actions.md) — which composite
  actions in `.github/actions/` are fleet-consumable, and the post-agent
  snapshot-then-`run:` pattern that keeps an agent's unrestricted Bash
  access from being able to tamper with its own finalization gates.
- [`docs/github-label-contract.md`](github-label-contract.md) — the
  `agent:*`/`status:*`/`review:*` label vocabulary referenced throughout
  this document.
- [Issue #645](https://github.com/jlapenna/agent-lcars/issues/645) — the
  full architecture decision, phase plan, and comment history this
  document draws its Phase 1–5 status from.
