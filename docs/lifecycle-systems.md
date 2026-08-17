# Operational ownership and runbooks: agent dispatch

This document answers one question: when agent dispatch breaks, whose
problem is it, and what do you check first?

> [!IMPORTANT]
> **The dispatch decision loop was rewritten (2026-08-15, #1015).** The
> Firestore-ledger dispatch controller described by earlier revisions of
> this document (issue [#645](https://github.com/jlapenna/agent-lcars/issues/645)'s
> five-system design: Dispatch controller, Runner platform, Worker runtime,
> Outcome finalizer, Projector/read model) was replaced by
> [`libs/orchestrator`](../libs/orchestrator) — a much smaller durable
> per-task mutex. `libs/orchestrator/src/model.ts` and
> [`decide.ts`](../libs/orchestrator/src/decide.ts) are the source of truth
> for what it actually does; this document only summarizes. The canary/alert
> system (`dispatch-canary`, `bootstrap-canary`, `opencode-model-canary`,
> `webhook-ingress-canary`, `canary-alert`, `post-deploy-smoke`, and the
> per-workflow alert issues) was deleted earlier, per maintainer direction
> (#887); nothing below refers to it. Runner platform (system 2) and most of
> Worker runtime (system 3) were not part of this rewrite and are still
> accurate as described.

## Current design: the orchestrator

The orchestrator is a durable **per-task mutex with an audit trail**, not a
generic workflow engine. A task is a GitHub issue or PR someone wants
worked; a run is one execution of it. The one invariant it owns: a task
never has two live runs at once. A request while a run is live is refused,
never queued. It takes no view of what a run produced — results are
recorded verbatim (`ok`, `summary`, `ref`) and judging them belongs to the
task, not the orchestrator. See `libs/orchestrator/src/model.ts`'s own
header comment for the full statement of scope.

**Code:**

- `libs/orchestrator/src/model.ts` — the schemas (`Task`, `Run`,
  `OutboxEntry`) and their invariants, in comments next to the code they
  govern.
- `libs/orchestrator/src/decide.ts` — pure decision logic (`requestRun`,
  `confirmDispatch`, `renewLease`, `reportResult`, `cancelRun`,
  `expireLease`). No I/O, no clock reads; every function returns a
  `Decision` or a `Refusal`; storage applies a decision atomically or not
  at all.
- `libs/orchestrator/src/orchestrator.ts` — the only place I/O and time meet
  the decision layer: read → decide → apply, with one retry on a lost
  compare-and-set.
- `libs/orchestrator/src/store.ts`, `firestore-store.ts`, `memory-store.ts`
  — the storage contract and its two implementations (see
  `libs/orchestrator/README.md`).
- `apps/console/src/lib/orchestrator-routes.ts` — the three HTTP handlers
  (`handleWebhookDelivery`, `handleCompletion`, `handleReconcile`), kept out
  of `app/api/**` so they're testable without Next.js's Request/Response
  plumbing.
- `apps/console/src/lib/orchestrator-ingest.ts` — pure webhook-payload
  interpretation: which `issues`/`pull_request`/`issue_comment` events are a
  request to work a task, and with which pipeline/mode.
- `apps/console/src/lib/orchestrator-dispatch.ts` — the outbox drain: turns
  a `dispatch-run` entry into a real `workflow_dispatch` call, and a
  `report-outcome` entry into a real issue comment. Nothing here is durable
  itself — `store.claimPendingOutbox`/`settleOutbox` own that, so a failed
  GitHub call just leaves its entry `pending` for a later drain to retry.
- `apps/console/src/lib/orchestrator-runtime.ts` — builds the real runtime
  dependencies (Firestore-backed store, a real clock, the outbox drain
  bound to the fleet's GitHub token), memoized per server instance.
- `apps/console/src/app/api/control-plane/{webhook/process,completion,reconcile}/route.ts`
  — thin Next.js route shells: verify auth (HMAC for the webhook, exact
  GitHub Actions OIDC for completion/reconcile), parse the body, call the
  matching handler above, forward its `{status, body}` verbatim.

**How a run flows:** a webhook delivery lands on `/api/control-plane/webhook/process`,
gets HMAC-verified and interpreted; if it's a request, `Orchestrator.request()`
takes the task's mutex (or refuses `task-busy`/returns the existing run for a
duplicate delivery) and enqueues a `dispatch-run` outbox entry. The route
handler drains the outbox synchronously, which fires a `workflow_dispatch`
call carrying the run's ID as `broker_intent_id`/`broker_generation` inputs.
The worker (`claude.yml`/`codex.yml`/`opencode.yml`) derives its attempt
identity directly from those trusted inputs — there is no worker-side
re-verification of admission or ledger binding; the orchestrator already
authenticated and admitted the dispatch before `workflow_dispatch` fired
(see Worker runtime, below). When the worker finishes,
`agent-fallback-finalize.yml`'s completion callback posts to
`/api/control-plane/completion` with an exact-workflow OIDC token; that
calls `Orchestrator.report()`, which releases the mutex and enqueues a
`report-outcome` entry the same drain turns into the outcome comment on the
issue.

**Lease and auto-retry:** a live run must renew its lease (2 hours) or the
scheduled `dispatch-reconcile.yml` sweep (`/api/control-plane/reconcile`,
every 30 minutes) marks it `lost` and releases the mutex —
`libs/orchestrator/src/decide.ts`'s `expireLease`. That alone never starts a
new run; a lost run may have half-finished work behind it. `Orchestrator.sweepExpired()`
then immediately requests a fresh run for the same task (same pipeline,
same params) as long as the task hasn't gone `lost` more than `MAX_AUTO_RETRIES`
(2) times in a row since its last `finished`/`canceled` settlement — past
that, the task is left parked for a manual request, and the outcome comment
says so.

**Deliverable evidence is unchanged.** The orchestrator's `report()` only
records whatever the worker's completion callback claims; it does not
verify the deliverable itself. `.github/actions/verify-deliverable` still
runs as one of the worker's own post-agent gates and still requires the
exact `<!-- attempt-claim:<attempt-id> -->` marker on a PR/comment/review
before the worker can report success — see Worker runtime, below, and
[`docs/published-actions.md`](published-actions.md).

## Symptom → owning system

| What you observe                                                                                                      | Owning system                                 | Look here first                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue carries the right `agent:*` label but nothing dispatches, no admission log for the delivery                     | Orchestrator (webhook admission)              | GitHub App delivery history, then `/api/control-plane/webhook/process` and Cloud Tasks logs                                                                 |
| Webhook ACKed but the queued `/api/control-plane/webhook/process` request returns 4xx/5xx                             | Orchestrator (webhook admission)              | App Hosting logs for HMAC, payload interpretation, or store failure                                                                                         |
| A worker (`claude.yml`/`codex.yml`/`opencode.yml`) job sits **queued**, never starting                                | Runner platform                               | `gh api repos/<owner>/<repo>/actions/runners` against `${{ vars.AGENT_RUNNER_LABEL }}`                                                                      |
| Worker fails during checkout, App-token mint, tool setup, or telemetry sidecar startup — before the agent itself runs | Worker runtime (bootstrap phase)              | The job's steps before "Run Claude Code" / "Run Codex" / "Run OpenCode"                                                                                     |
| Worker fails with a provider/model error (rate limit, auth)                                                           | Worker runtime (provider admission/execution) | The agent step's own log                                                                                                                                    |
| Agent process exits 0, but no PR/comment/review carries the exact attempt-claim marker                                | Worker runtime (deliverable evidence)         | `.github/actions/verify-deliverable`'s log line naming the exact artifact it matched (or the FAILED-lookup name)                                            |
| A worker run failed but the issue never got an outcome comment                                                        | Orchestrator (completion) or its fallback     | `agent-fallback-finalize.yml`'s "Return completion observation to the broker" step, then `/api/control-plane/completion` logs                               |
| No outcome comment ever appeared even though the callback reported `completion-sent=true`                             | Orchestrator (outbox drain)                   | `drainOutbox`'s `failed` entries in the completion/reconcile route's JSON response; a failed GitHub call just leaves the entry `pending` for the next drain |
| A task looks stuck (no run, no comment, no progress) for a long time                                                  | Orchestrator (reconciliation)                 | `dispatch-reconcile.yml`'s run history, then `/api/control-plane/reconcile`'s response body (`lost`/`retried`/`dispatched`/`reported`)                      |
| The console's Retry / Reassign-pipeline UI action fails                                                               | Orchestrator (console command path)           | `apps/console/src/lib/backend-actions.ts`'s `retriggerIssue`/`reassignPipeline`, which call the same `notifyReconcile` sweep as other mutations             |

## 1. Runner platform

**Owns:** compute capacity — runner creation, placement, readiness, queue
pressure, and runner loss — across the shared Docker host pool. Unrelated
to the dispatch decision loop above; unaffected by the orchestrator
rewrite.

**Code:**

- `apps/runner-autoscaler/*.go` — the orchestrator process:
  `orchestrator.go` (scale-set listener supervision), `scaler.go`
  (placement), `fleet_coordinator.go`, `checkpoint.go` (quiesce/restart
  state), `hosts.go`, `runner_status.go`, `metrics.go`, `config.go`,
  `github_http.go`, `github_app_token.go`.
- `apps/runner-autoscaler/runner-image/` — the JIT worker image
  (`Dockerfile`, `entrypoint.sh`, `externals-health.sh`) — this is also
  where `apps/telemetry-watcher`'s bundle gets baked in, built fresh from
  this repo's own `main` at image-build time (see `AGENTS.md`).
- `apps/runner-autoscaler/control-plane-image/Dockerfile` — a separate
  image for the control-plane pool specifically.
- `apps/runner-autoscaler/README.md` — build/test, live-reload (`SIGHUP`),
  quiesce-vs-drain (`SIGTERM` vs `SIGUSR1`), and checkpoint semantics; read
  it before touching a running instance.

**Its runtime configuration does not live in this repo.** `orchestrator.yml`
(homelab's, not to be confused with `libs/orchestrator` above) — fleet host
inventory, GitHub App credentials, and the scale-set definitions that
decide which label(s) get a listener at all — is owned by `jlapenna/homelab`'s
`github-runner-autoscaler/` directory, deployed by that repo's Ansible
playbook. `docs/onboarding-autoscaler.md` documents the split in detail.
agent-lcars _names the labels_ its own workflows expect
(`AGENT_RUNNER_LABEL`, `DEFAULT_RUNNER_LABEL`, `CI_RUNNER_LABEL` — see
`docs/deployment-boundary.md` §3). Whether anything is actually listening
for a given label is entirely homelab's question to answer.

**First three things to check:**

1. `gh api repos/<owner>/<repo>/actions/runners` — is there a registered
   runner carrying the exact label a stuck job's `runs-on:` names? None
   means the platform never provisioned one for that label, regardless of
   what config says it should.
2. On homelab: `docker logs runner-autoscaler | grep -oE "scale_set=[a-z-]+" | sort -u`
   — the scale sets the **running process** actually serves. Compare
   against the label the stuck job wants and against homelab's current
   `orchestrator.yml`. Config and the running process can disagree
   indefinitely after an edit with no reload.
3. Ask whether `orchestrator.yml` was edited without a following `SIGHUP`
   (live reload) or container restart — a config edit alone changes
   nothing until one of those happens.

**Who/what repairs it:**

- A config change with no reload/restart: nothing in agent-lcars can fix
  this. It is entirely a homelab-side operation, and this repo cannot even
  observe it directly.
- Runner loss or a crashed process: the orchestrator's own boot sweep and
  periodic sweep re-adopt existing containers from Docker labels (README's
  "Boot sweep and unreachable hosts"); no agent-lcars action needed.
- Genuine capacity exhaustion: a human, via homelab's fleet/host inventory
  and placement tuning.

## 2. Worker runtime

**Owns:** preparing the execution environment (bootstrap) and faithfully
invoking the requested agent/provider combination, then proving what it
produced.

**Code:**

- `.github/workflows/claude.yml`, `codex.yml`, `opencode.yml` — thin
  callers (#1312 U1): each keeps only what `workflow_call` cannot carry
  (the `workflow_dispatch` input contract, the contract-tested run-name,
  the permissions grant, and the repo-variable spellings passed down as
  inputs) and delegates the whole self-hosted worker job to its published
  reusable lane, `.github/workflows/agent-lane-<agent>.yml`, consumed
  same-repo. The lane owns the step sequence: snapshot enforcement
  scripts → publish attempt identity → mint agent token → claim issue →
  checkout → dispatch bootstrap → agent handoff/setup → verify agent
  identity → prepare dispatch context → start telemetry sidecar → run the
  agent → run post-agent gates. Each caller also runs a second,
  GitHub-hosted `fallback-finalize` job (`needs` the lane job,
  `if: always()`) that calls the shared `agent-fallback-finalize.yml`
  when the primary path cannot prove it completed (#639) — a
  bootstrap-independent safety path.
- `.github/actions/dispatch-bootstrap` (Coupled, see `published-actions.md`)
  — **a thin executor** (#1015/#1179): it derives this attempt's
  `g<generation>:<intentId>` identity directly from the trusted
  `broker-generation`/`broker-intent-id` `workflow_dispatch` inputs the
  orchestrator's outbox drain sent, instead of authenticating to Firestore
  and re-proving a binding the server already holds. There is no
  worker-side re-verification of admission.
- `.github/actions/agent-setup`, `mint-agent-token`, `verify-agent-identity`,
  `prepare-agent-dispatch`, `setup-opencode`, `telemetry-start` — shared
  bootstrap pieces (Published/Internal — see `published-actions.md`).
- `.github/actions/archive-opencode-trajectory` — after OpenCode runs,
  exports every workspace-scoped session with `opencode export --sanitize`
  and uploads it as a 30-day artifact. Export failure is visible but
  fail-soft.
- `.github/actions/verify-deliverable` — the fleet deliverable-evidence
  gate. A run passes only when a PR, issue/PR comment, or (review dispatches
  only) a pull request review carries **this run's own** hidden
  `<!-- attempt-claim:<attempt-id> -->` marker (#815) — no time window, no
  bot-login comparison, no author exclusion, for every consumer. The
  guarded legacy-inference compatibility path standalone Published-action
  consumers once used (#4388) was removed after every fleet consumer
  flipped to passing an attempt ID (homelab#697, sprinkles' exact-marker
  flip); `attempt-id` is required.

**Credential boundaries, concretely** (worker workflow, `claude.yml` as the
example — the other two lanes match): the agent step never receives
`github.token`. The agent instead gets a separately minted Agent LCARS App
token (`mint-agent-token`) for its own claim/comment/push identity, a
distinct telemetry WIF credential (`telemetry-start`, impersonating a
write-only `telemetry-writer` service account), and, optionally,
`AGENT_CI_RERUN_TOKEN` — a classic PAT at `public_repo` scope from the
`agent-lcars-bot` machine account, not `github.token`, so the agent can rerun its
own failed CI without holding a control-plane-capable credential. The
post-agent completion callback (`agent-fallback-finalize.yml`) runs on
`ubuntu-latest` from a separate job with its own exact-workflow OIDC token,
never the worker job's own token.

**What breaking looks like:** two distinct failure shapes. A **bootstrap**
failure (App-token mint, checkout, tool setup, or the telemetry sidecar
dying) happens before the agent ever runs — it shows up as a failed step
above "Run Claude Code"/"Run Codex"/"Run OpenCode" in the job log. A
**provider/agent execution** failure (a rate limit, an auth rejection)
happens inside the agent step itself. Neither is an orchestrator problem —
a bootstrap failure still reaches `agent-fallback-finalize.yml`'s
completion callback (worker-token minting failing is an explicit scenario
this workflow handles), and a provider failure is bounded, worker-owned
retry, never orchestrator-level retry. Separately, an agent process that
exits 0 without stamping the attempt-claim marker on its artifact fails
`verify-deliverable`, which is a real gap (the agent didn't stamp it), not
a false negative.

**The start-of-bootstrap reporting gap is covered by an independent
fallback (#639).** Each worker's primary post-agent step runs
`bash "$RUNNER_TEMP/trusted-actions/post-agent-gates/post-agent-gates.sh"`
unconditionally (`if: always()`), but that script is written to
`$RUNNER_TEMP` only by the earlier "Snapshot post-agent enforcement
scripts" step, which itself depends on checkout having already succeeded.
If checkout or that snapshot step fails, the primary path cannot run at all
— `.github/actions/report-failure` no longer writes GitHub state directly
in that case (#813); `agent-fallback-finalize.yml` always runs on
`ubuntu-latest`, independent of whether checkout/the runner itself survived
on the worker's own job, and its "Derive trusted completion evidence" +
"Return completion observation to the broker" steps re-derive the outcome
from GitHub's job/step metadata and send it through the OIDC-authenticated
completion callback into the orchestrator. Only when that callback itself
cannot reach the hosted control plane does this workflow fall back to
writing a comment/label/assignee directly with its own native token — the
minimum bootstrap-safe fallback for "no authenticated evidence channel
reached the orchestrator at all." The scheduled reconcile sweep is the
backstop if even that direct write's own retries are exhausted (the run
still goes `lost` on lease expiry and gets picked up by auto-retry/parking).

**First three things to check:**

1. Which step failed: before or after the agent step itself? Before means
   bootstrap; at or after the agent step means provider/agent execution.
2. The agent step's own log for the provider's error text.
3. If deliverable validity is in question, `verify-deliverable`'s own log —
   it names the exact artifact it matched, or the FAILED-lookup name if the
   check itself errored.

**Who/what repairs it:** nothing automatically retries a worker-runtime
failure at this layer — provider retry is bounded and stays inside the
worker's own adapter. Recurrence across multiple dispatches is a human
problem: a stale credential, a provider outage, or a broken bootstrap step
needs a maintainer, not a reconciler. At the task level, though, a run that
never reports (bootstrap death, runner loss, or any other silent failure)
still eventually goes `lost` on lease expiry and is auto-retried by the
orchestrator's sweep, bounded by `MAX_AUTO_RETRIES` — see "Current design"
above.

## History: what came before

Issue [#645](https://github.com/jlapenna/agent-lcars/issues/645) built the
original five-system design named at the top of this document: a
Firestore-ledger dispatch controller (`apps/dispatch-broker`,
`libs/dispatch-reconcile`, a pinned `<!-- agent-lcars:dispatch-ledger:v1 -->`
comment as a human-readable projection of Firestore authority), an outcome
finalizer (exact attempt-claim marker verification plus a separate
execution-state classifier), and a projector that centralized every
GitHub-facing write behind one idempotent writer (#813). It worked, and
several of its findings are still true today (the deliverable-evidence
marker design, the credential-separation boundaries) — they're described
under Worker runtime above because they didn't change.

What made the ledger design worth replacing was its own size: five systems,
a forgeable-by-design compatibility comment (`loadLedger`/`saveLedger`
authenticated by comment _author_, which editing a comment never changes),
and machinery (generations, anomalies, a `ControlEvidence` audit trail, a
canary-per-system alerting layer) that existed to keep that size
manageable rather than to do the actual job — a per-task mutex. #1015's
four waves (#1171, #1172, #1177, #1179, #1181; the live cutover verified
end-to-end in #1178) built `libs/orchestrator` as that mutex, wired it into
`apps/console`'s control-plane routes, made worker bootstrap thin, and
deleted the ledger machinery, the deliverable-watchdog action/workflow,
this repo's own `rerun-infra-killed-runs.yml` cron (subsumed by the
orchestrator's lease sweep), and the Claude-lane-readiness probe. Full
detail — including the ledger-forgery finding, the "a GitHub concurrency
group is a lossy queue" incident, and the runner-platform outage worked
example — is in this document's git history (`git log -p -- docs/lifecycle-systems.md`)
rather than repeated here.

Neither survives today. `apps/console/src/lib/hosted-controller.ts` was
retired first (#1195), moving the console UI's post-mutation reconcile ping
(`apps/console/src/lib/backend-actions.ts`'s `notifyReconcile`) onto the
same orchestrator sweep as every other mutation. That left the
still-externally-published `rerun-infra-killed-runs` action bundle as
`apps/dispatch-broker`'s only remaining reason to exist; agent-lcars#1183
carved its true import closure out into its own `apps/rerun-infra-killed-runs`
project, and #1199 then deleted `apps/dispatch-broker` outright (50 files)
since nothing else consumed it. The action bundle itself stayed published
a while longer for `jlapenna/homelab` and `supersprinklesracing/sprinkles`'s
own crons — both have since migrated onto the central orchestrator's lease
sweep and bounded auto-retry, so agent-lcars#1201 deleted the action and
`apps/rerun-infra-killed-runs` too. Nothing from the original five-system
design remains.

## Related docs

- [`libs/orchestrator/README.md`](../libs/orchestrator/README.md) — the
  orchestrator's own one-page design summary.
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
- [`docs/attempt-service.md`](attempt-service.md) — a superseded design
  document (the "Lifecycle Control Plane"), kept only as a historical
  pointer to this one.
- [`docs/github-label-contract.md`](github-label-contract.md) — the
  `agent:*`/`status:*`/`review:*` label vocabulary referenced throughout
  this document.
- [`docs/consumer-lifecycle-inventory.md`](consumer-lifecycle-inventory.md)
  — which consumer-repository recovery workflows exist outside this repo
  and how they relate to the orchestrator.
