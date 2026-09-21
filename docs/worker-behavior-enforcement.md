# Dispatched-worker behavior enforcement

Status: implementation foundation, **not enabled in dispatch**. No provider
has graduated. The offline readiness evaluator, native-hook boundary probes
for all three providers, and a Claude/Codex failure-to-denial bridge are
implemented. Idempotent Claude/Codex command registration is exercised by the
native probes. Runner setup integration, policy handlers, bounded recovery/completion
and full acceptance canaries remain to be built and verified.

## Scope and decisions

Apply initially to LCARS-dispatched workers, not interactive sessions. Keep
tools and credentials available; do not introduce a credential/API gateway.
This is workflow enforcement at documented interception points, not a
bypass-proof security boundary. Unsupported paths must be stated explicitly.

Share behavior in `packages/fleet-tools`, with thin provider adapters. Consume
repo-tools worktree guards rather than copying them. Retain judgment and
task-specific guidance in skills; shorten instructions only after executable
replacement has passed runtime canaries.

## Requirement-to-enforcement matrix

| Mandatory requirement                           | Existing implementation                                                                                             | Remaining enforcement                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Session/attempt identity and dispatch mode      | `direct-runner.sh` consumes the trusted brief and exports attempt identity; protocol defines mode-specific outcomes | Bind provider session to the trusted attempt; reject invalid context before launch; prevent mode-incompatible protected actions          |
| Ownership before implementation and publication | Orchestrator task mutex and initial GitHub claim; lifecycle check at claim                                          | Fresh ownership check before first implementation and publication; reject uncertain or changed ownership with correction instructions    |
| Worktree protection                             | repo-tools guards via repository Git hooks                                                                          | Verify guards in the actual worker checkout; probe allowed linked-worktree and rejected primary-checkout mutations                       |
| Deliverable markers and completion              | Shared `verify-outcome.sh`, direct-runner finalization; OpenCode bounded continuation                               | Idempotent marker repair for supported artifact paths; reuse verifier for completion correction on all providers within remaining budget |
| Explicit review holds before ready/auto-merge   | Protocol requires fresh feedback and hold satisfaction                                                              | Intercept supported ready/arm operations; require fresh hold evidence and explicit satisfaction, never automatically clear a hold        |

`packages/fleet-tools/bin/codex-issue-guardrail.cjs` returns PostToolUse
context. It is advisory, not pre-action rejection. A passing configuration
check or successful hook invocation does not demonstrate enforcement.
Titles and progress remain non-blocking observability.

## Setup ownership and runtime behavior

Setup owns installation and verification. Image/package setup installs the
shared handlers and provider registrations. Session bootstrap binds them to
the trusted attempt and verifies the effective configuration with an execution
smoke before launching work. Missing hooks are a setup failure, not a reason
to add installation-presence checks to every runtime action. Setup must be
idempotent and rerun for image/provider/package upgrades and recreated worker
environments. Qualification remains artifact-matched and provider-specific.
Do not enable the new setup requirement before the corresponding provider
implementation and canaries pass; this foundation must not disable the fleet.

During execution, a broken control blocks affected protected actions. Preserve
session and unpublished work. Permit bounded automatic repair, then rerun the
affected control's execution probe before resuming. This is recovery from an
actual execution failure, not repeated installation discovery. Exhausted repair is infrastructure failure, not
a fabricated human blocker. Set retry/time limits within the existing run
budget, not as a fresh budget. Avoid replaying a possibly completed external
write: read back its result before retrying.

Mechanically repair omitted attempt markers on supported deliverables; never
invent identity or stamp unrelated artifacts. Ownership, authorization and
review holds require rejection with actionable feedback, not automatic repair.
For premature normal completion, return missing deliverable requirements to
the same session while budget remains. Otherwise retain an incomplete outcome
and work. Preserve the existing finalizer's verification after abnormal exits.

## Concurrent canaries and independent graduation

Run Claude Code, Codex and OpenCode concurrently on separate test anchors,
branches, sessions and output directories. Use the same scenarios below.
One provider's failure must not block another provider's graduation. No shared
PR or issue should be modified by multiple canaries.

| Scenario ID            | Required observable result                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `valid-work`           | Ordinary authorized implementation and publication succeed                                    |
| `invalid-identity`     | Missing/mismatched attempt or session prevents launch                                         |
| `mode-violation`       | Review-mode implementation/push is rejected at supported interception points                  |
| `ownership-lost`       | Changed or unreadable ownership prevents implementation/publication                           |
| `primary-worktree`     | Primary mutation rejected; dedicated worktree mutation succeeds                               |
| `missing-marker`       | Supported deliverable receives exact marker once; foreign artifacts unchanged                 |
| `premature-completion` | Missing artifact triggers bounded same-session correction; budget exhaustion stays incomplete |
| `review-hold`          | Ready/arm rejected while hold persists; satisfied hold permits authorized action              |
| `missing-hook`         | Setup installs an omitted hook; failed installation/verification prevents worker launch       |
| `hook-failure`         | Failed/timed-out hook prevents the affected action, without losing work                       |
| `recovery-success`     | Repair plus successful health probe resumes the preserved session                             |
| `recovery-exhausted`   | Bounded repair ends as infrastructure failure, no human assignment                            |
| `authorized-exception` | A specific trusted-policy exception works without relaxing unrelated restrictions             |

Probe drivers must invoke the actual pinned provider runtime and observe
side effects independently (for example a sentinel file or captured local
API request). Test allow and deny paths: an agent simply declining to call a
tool is not proof of interception. Inject hook absence, failure and timeout.
Record direct API, shell, compound-command and alternate-tool coverage;
do not generalize a `gh` interceptor into coverage of every GitHub write.

## Offline evidence gate

Run `node packages/fleet-tools/bin/worker-readiness.cjs report.json expected.json`.
Exit 0 means the supplied evidence qualifies; exit 1 means it does not.
This evaluates reports; it does **not** run provider probes, authenticate
evidence, fetch artifacts, or replace setup's execution smoke.

The trusted canary runner supplies both files, never the worker under test.
Expected identity has `provider` (`claude`, `codex`, `opencode`),
`providerVersion`, `imageDigest`, `policyDigest` and `adapterDigest` strings.
The report includes those same fields plus `schemaVersion: 1`, ISO timestamps
`startedAt` and `expiresAt` (UTC `YYYY-MM-DDTHH:mm:ssZ`, optionally with
exactly three fractional-second digits), and `results`. Each result has `scenario`,
`status: "passed"`, `evidenceKind: "runtime"` and a nonempty `evidenceRef`
pointing to retained probe evidence. The runner owns retention, authenticity
and expiry policy; expiration must be short enough for its rollout window.

Missing, duplicate, failed, skipped, advisory-only, expired or artifact-mismatched
evidence refuses qualification. Contract tests run in the existing required
`check:contracts` lane; no new advisory CI job is introduced.

## Delivery sequence

1. Foundation: this matrix and offline evidence gate.
2. Build actual provider probe drivers; establish native interception and stop
   behavior against the pinned runner versions, including failure semantics.
3. Implement shared behavior and thin adapters; reuse existing ownership,
   worktree and outcome checks. Add setup installation/verification, repair and completion
   integration only after the probes establish supported interception points.
4. Run the three isolated canaries concurrently; retain evidence and graduate
   passing providers independently. A provider unable to cover a mandatory
   control stays unqualified; report its exact gap rather than weaken the rule.
5. Enable graduated providers, observe false rejections and recovery outcomes,
   then remove superseded prose. Interactive sessions remain a later phase.

## Native OpenCode boundary probe

Run the real executable against a deterministic localhost model:

```sh
node tools/probes/opencode-hook-boundary.mjs /absolute/path/to/opencode 1.18.25
```

The version must match exactly. The runner's pin is in
`apps/runner-autoscaler/runner-image/opencode-version`; local results from
another version are diagnostic only. The probe creates isolated temporary
homes/workspaces and uses an allowlisted environment without real credentials.
It retains stdout, stderr, hook receipts and observations under the printed
temporary directory. It never publishes GitHub artifacts or changes global
provider configuration. The CLI has a 60-second deadline per case.

The localhost model requests one harmless shell sentinel write. The probe
independently checks tool-result delivery, hook invocation and the actual file:

- Allow: hook runs and the sentinel exists.
- Deny: hook runs and the sentinel does not exist.
- Dependency failure: a thrown hook error prevents the sentinel write.
- Missing hook: the sentinel exists, exposing the need for LCARS admission.

Exit zero means these native behaviors were observed, **not** that the
mandatory LCARS canary suite passed. This probe deliberately reports
`qualification: "not-evaluated"`; it must not be converted to a passing
readiness report. It does not yet test completion, ownership, marker repair,
recovery, timeout handling, or the installed runner image as a whole.

The hook API comes from the [OpenCode plugin reference](https://opencode.ai/docs/plugins/).
The missing-hook behavior must be prevented by setup installation and its
execution smoke, not recurring runtime installation checks.

## Execution-mode and convergence acceptance gates

These are required evidence for the project, not permission to impose worker
policy on interactive sessions or to claim fleet convergence from an image test.

- [LCARS #2031](https://github.com/jlapenna/agent-lcars/issues/2031): inventory
  authoritative member repositories, instructions and registrations, starting
  with available local checkouts. Correct autonomous-policy leakage at the
  shared source; retain collision checks and shared safety. Record clean
  results and unavailable coverage. Coordinate overlapping hook work.
- [Homegit #82](https://github.com/jlapenna/homegit/issues/82): verify declared
  interactive accounts through canonical reconciliation/package updates.
  Preserve unrelated hooks, local conflicts, disabled reconciliation and active
  sessions. Record per-account revisions, relevant effective configuration,
  offline/gated accounts and no-op repeat verification. Never print secrets.
- [LCARS #2032](https://github.com/jlapenna/agent-lcars/issues/2032): fresh
  interactive sessions for each active harness must read unclaimed and closed
  issues without autonomous refusal or writes, and perform a bounded directly
  authorized task. Observe a legitimate dispatch through the normal control
  plane, including console-owned claim, explicit attempt identity and durable
  deliverables. Record revisions, session identities, hook paths and GitHub
  state readback. Do not generate unrelated dispatch/comment churn.

Interactive sessions must not acquire fleet claim, takeover, marker, PARK or
status-cadence obligations. Shared worktree, secrets, verification and operation
approval rules remain applicable. Provider canaries can run concurrently and
graduate independently, but cannot substitute for these separate acceptance
gates. #2033 is a separate LCARS-wide setup/runtime audit, not this project's
implementation scope.

## Native Claude/Codex command-hook boundary

```sh
node tools/probes/command-hook-boundary.mjs codex /absolute/path/to/codex 'codex-cli 0.155.1'
node tools/probes/command-hook-boundary.mjs claude /absolute/path/to/claude '2.1.278 (Claude Code)'
```

Like the OpenCode probe, this uses isolated homes, a deterministic localhost
model, explicit version matching and an independently observed sentinel write.
The raw-hook cases measure allow, deny, exception and omission. The bridge
cases measure allowed execution, handler exception and a handler that hangs.

On the tested Codex 0.155.1 and Claude Code 2.1.278, raw command-hook exceptions
allowed the requested action. The shared `worker-hook-bridge.cjs` instead
converted exceptions and its five-second handler timeout into explicit native
PreToolUse denials; the actual CLI then prevented both sentinel writes. The
allowed case still executed. These seven observations passed on each CLI.
Runner image qualification must record the versions actually baked into that
image; the image currently installs current Claude/Codex releases at build.

The bridge is silent outside explicit LCARS context and does not read stdin or
invoke its handler for an interactive session. It validates a narrow allow/deny
output schema, suppresses potentially sensitive handler diagnostics, and does
not yet support tool-input rewriting. Setup must register an outer hook timeout
longer than the bridge timeout. Handler paths come from setup, not task content.
The bridge is not yet installed in worker launch configuration, and it does not
implement ownership, worktree, marker, or review-hold policy itself.

`worker-hook-setup.cjs` installs the command registration into a caller-selected
worker JSON configuration (Claude settings or Codex hooks). It checks readable,
syntactically valid handler modules before writing, preserves unrelated
settings/hooks, rejects malformed or symlinked configuration, updates only its
managed registration, and makes identical repeat setup a no-op. Replacement
uses a temporary file and rename, with readback verification. The registration
also maps bridge process failure to native exit-code-2 denial.

The native command-hook probes now call this setup implementation for their
bridge cases, including a no-op repeat, before starting the actual CLI. Setup
registration alone does not prove execution: the caller must still complete
its native execution smoke before launching task work. This helper is not yet
wired into the runner and does not mutate interactive workstation configuration.
