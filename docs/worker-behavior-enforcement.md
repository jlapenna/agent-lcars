# Dispatched-worker behavior enforcement

Status: implementation foundation, **not enabled in dispatch**. No provider
has graduated. The offline readiness evaluator, native-hook boundary probes
for all three providers, and a Claude/Codex failure-to-denial bridge are
implemented. Idempotent Claude/Codex command registration is exercised by the
native probes. The initial shared policy handles literal Git/PR mutations and
native file-edit tools with mode, worktree and fresh GitHub ownership decisions.
It repairs omitted attempt markers on supported new PR/comment/review commands;
native probes check that the repaired body reaches the local transport.
An OpenCode adapter translates tool events into the same shared policy, and
setup installs its registration. Setup binds validated dispatch context once.
Fresh readiness checks cover review threads, requested changes, blocking labels,
and acknowledgments of external draft/auto-merge holds.
The direct runner now shares one bounded completion-correction rule across all
three providers, verified by its executable runner harness. Runner setup
integration, remaining policy controls, bounded control recovery,
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

### Initial policy coverage (not enabled)

`worker-policy.cjs` validates the setup-owned attempt/run/anchor binding and
evaluates native file edits plus literal Git mutations and `gh pr
create/ready/merge` commands. It delegates checkout protection to the installed
`repo-require-worktree` guard and reads current GitHub anchor ownership for
each supported mutation. Native Work uses the orchestrator's mutex, not an
invented issue claim. Read-only operations do not trigger those reads.

This is partial coverage: scripts, shell expansion, pipelines/redirection,
indirect command wrappers, arbitrary HTTP/MCP writes, patch target extraction,
and arbitrary human-condition verification are not implemented by this handler.
The focused policy tests feed the required Verify contract lane; they do not
qualify a provider or authorize enabling the incomplete handler in dispatch.

Marker repair currently covers a single literal `gh pr create`, `gh issue
comment`, `gh pr comment` or `gh pr review` command with one explicit body or
regular body file. It resolves the repository and requires an exact anchor for
comments/reviews. Other repositories/anchors and existing-object edits are not
stamped. Body files remain unchanged; the replacement command receives the
original text plus the exact marker. Ambiguous flags, streaming bodies and
foreign attempt claims are rejected with correction instructions. Compound
shell publication commands and arbitrary API writes are not covered yet.

`worker-review.cjs` reads current PR state with paginated review threads and
hold/comment timeline events before supported `gh pr ready/merge` operations.
These calls require an explicit PR number and `--repo`, preventing evidence
for one repository from allowing a write to another. Incomplete lookups,
changing heads, unresolved threads, requested changes and blocked/parked labels
reject readiness. Explicit undo/disarm actions remain available.

An external draft conversion or auto-merge disable requires either a matching
release by its actor, or a later response authored by the current authenticated
worker and bound to that event and current PR head:
`<!-- lcars-hold-response:<event-id>:<head-oid> -->`. The response must explain
how the stated gate was satisfied; the handler never writes it automatically.
It cannot override unresolved reviews or blocked labels. This is an explicit
acknowledgment contract, **not proof of arbitrary human-condition satisfaction**.
Interpreting narrative feedback, reviewing anchor comments, and recognizing
narrowed closing references still require the retained protocol and additional
acceptance coverage before qualification.

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

`runtime/worker-completion.sh` now owns the common completion decision in
`direct-runner.sh`: only an exit-zero round followed by a completed exact-marker
lookup reporting no deliverable can receive one correction. Claude gets a
preallocated session UUID (or its restored session); Codex uses the CLI's
top-level `thread.started` event, never text-scraped identity; OpenCode retains
its unambiguous session discovery. All recheck the live lease and share the
original deadline. Native Work terminal records, lookup failure, missing session
identity, provider errors and expired budgets do not trigger correction.
The runner harness exercises each branch and finalizes failures normally.
Native Claude/Codex probes verify that the runner's session-id/resume flags
retain the same session and execute a second command. The combined native
completion canaries and live dispatch proof are still required.

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
- Shared policy marker: the local GitHub-transport fixture receives the exact
  repaired comment body through `worker-opencode-plugin.mjs`.
- Shared policy ownership loss: the fixture reports a closed anchor and no
  publication occurs.
- Shared policy lookup failure: a failed ownership read prevents publication.

Exit zero means these native behaviors were observed, **not** that the
mandatory LCARS canary suite passed. This probe deliberately reports
`qualification: "not-evaluated"`; it must not be converted to a passing
readiness report. It does not yet test completion, recovery, timeout handling,
or the installed runner image as a whole. OpenCode argument repair must mutate
the existing `output.args` object: a native probe caught that replacing the
object left the original command unchanged. Policy probe cases now use the
OpenCode setup installer and verify an identical repeat is a no-op. The
installer is not yet connected to runner launch.

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
cases measure allowed execution, handler exception, a handler that hangs,
command rewriting, and the real policy's marker repair before a local
GitHub-transport fixture receives a comment body.

On the tested Codex 0.155.1 and Claude Code 2.1.278, raw command-hook exceptions
allowed the requested action. The shared `worker-hook-bridge.cjs` instead
converted exceptions and its five-second handler timeout into explicit native
PreToolUse denials; the actual CLI then prevented both sentinel writes. The
allowed case still executed. All ten observations passed on each CLI,
including an exact repaired marker in the independently captured comment body.
The tenth observation executes a second round within the same probe deadline:
Claude retains its preallocated UUID; Codex resumes the first hook's native
session ID. Both produce a separate second-round sentinel with unchanged
session identity. This tests native resumption, not the full completion gate.
Runner image qualification must record the versions actually baked into that
image; the image currently installs current Claude/Codex releases at build.

The bridge is silent outside explicit LCARS context and does not read stdin or
invoke its handler for an interactive session. It validates a narrow allow/deny
output schema and suppresses potentially sensitive handler diagnostics. It
accepts only the native Bash `updatedInput.command` rewrite proven by these
probes; malformed or unsupported rewrites become denials. This follows the
[Codex PreToolUse contract](https://learn.chatgpt.com/docs/hooks#pretooluse).
Setup must register an outer hook timeout
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

The setup module also exposes `prepareWorker` (CLI: `--worker <provider>
<config> <context> <brief> <run-id> <attempt-id>`). Paths must be absolute and
distinct. It validates the trusted brief/attempt binding, writes a per-attempt
context, and installs the provider registration. Reusing that context for a
different dispatch is rejected; repeating the same setup is a no-op. The result
still reports `executionSmokeRequired: true`: registration and identity binding
alone are not permission to launch. OpenCode plugin installation preserves
unrelated entries and uses the stable package/image file URL across upgrades.
