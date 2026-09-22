# Dispatched-worker behavior enforcement

Status: implementation in progress, **not enabled in production dispatch**. No provider
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
Native session metadata is bound to the setup-owned attempt before tool actions;
known Claude runner session IDs are also bound before launch.
The direct runner now shares one bounded completion-correction rule across all
three providers, verified by its executable runner harness. Hook setup is
connected to all three launch paths behind provider-specific qualification.
Bounded evaluator restart recovery and terminal infrastructure-failure
classification are implemented; remaining policy coverage and full acceptance
canaries remain to be built and verified.

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
indirect command wrappers, arbitrary HTTP/MCP writes,
and arbitrary human-condition verification are not implemented by this handler.
The focused policy tests feed the required Verify contract lane; they do not
qualify a provider or authorize enabling the incomplete handler in dispatch.

Native edits now resolve explicit file targets, including multi-edit entries
and standard `apply_patch` add/update/delete/move headers. Both named paths and
resolved symlink destinations are checked; malformed patches and dangling links
receive corrective denials rather than falling back to the current directory.
The native Codex patch hook supplies its patch in `tool_input.command`; the
adapter accepts that observed shape as well as the supported patch text forms.
This is pre-action workflow protection, not an atomic filesystem sandbox against
another process replacing a symlink after the check.

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

The current automatic repair is a fresh evaluator process, not package updates
or registration discovery. On an actual evaluator exception, timeout, or malformed
result, the adapter atomically consumes one attempt-bound allowance beside the
setup context (`.recovery-used`). It runs passive allow/deny execution probes,
then reevaluates the still-unexecuted action. Recovery has a four-second total
deadline inside the existing provider task deadline; command hooks allow fifteen
seconds for initial evaluation plus recovery and process overhead. A failed
probe, exhausted allowance, or mismatched context keeps the action denied with
an infrastructure-failure instruction, never a fabricated PARK. Genuine policy
denials do not consume recovery. No task command or publication is replayed by
the evaluator. The allowance persists across hooks and same-attempt resumed
rounds; setup does not clear it. This does not repair broken packages.

Recovery writes attempt-bound `.recovery-succeeded` or `.control-failed`
receipts without task contents. A later failure remains recorded even if an
earlier recovery succeeded. A consumed allowance without success evidence also
counts as failed, covering interruption during repair. Before a completion
correction and at terminal classification, the runner reads these execution
receipts at its setup-bound location; it does not inspect hook installation.
Unrecovered failure suppresses correction and reports `worker-control-failed`,
not PARK/no-op or success inferred from a process exit. The Work API stores this
as `ok: false`. A positively identified, exact-attempt PR, comment, or review
retains its deliverable outcome and reference; failure does not erase published
work. Unclassified success or a terminal PARK/no-op record cannot conceal the
infrastructure fault. Runner tests exercise all three providers; native probes
verify that successful and exhausted recovery produce distinct receipts.

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

### Current evidence and remaining qualification work

This ledger distinguishes native interception evidence from the complete,
image-bound scenario. No row grants provider graduation on its own.

| Scenario               | Current evidence                                                                                                                                        | Still required for full qualification                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `valid-work`           | Native feature edit and marker-repaired fixture comment succeed on all three CLIs                                                                       | Combined authorized implementation/publication/completion in the candidate runner image    |
| `invalid-identity`     | Setup rejects mismatches; native session-binding denials; pinned OpenCode session API verifies descendant mapping without replacing the root            | Candidate-image binding and actual delegated tool execution across providers               |
| `mode-violation`       | Native review-mode file edits are rejected with the expected policy reason                                                                              | Native publication/push rejection in review mode                                           |
| `ownership-lost`       | Native absent/unreadable ownership blocks edits; a two-tool session allows the first edit and blocks the second after ownership changes                 | Matching publication scenarios and candidate-image evidence                                |
| `primary-worktree`     | Real Git linked/primary fixtures and installed repo-tools guard; native direct and symlink-to-primary edits denied                                      | Candidate-image Git mutation/publication coverage                                          |
| `missing-marker`       | Native command repair reaches the local publication transport; unit tests cover foreign bodies and idempotence                                          | Native foreign-artifact/idempotence negative cases and full supported-deliverable coverage |
| `premature-completion` | All-provider runner harness; native same-session resumption on all three CLIs, with setup-bound OpenCode file edits before/after restart                | Combined native completion correction and exhausted-budget canaries                        |
| `review-hold`          | Native held/released readiness and merge-arm actions on all three CLIs; unresolved threads still block after holder release                             | Candidate-image evidence and remaining supported hold-satisfaction paths                   |
| `missing-hook`         | Native bootstrap installs omitted registration; runner harness refuses launch after setup failure                                                       | Combined candidate-image negative setup scenario                                           |
| `hook-failure`         | Native thrown failures deny; Claude/Codex native timeout denies                                                                                         | OpenCode timeout coverage and preserved-work proof in candidate image                      |
| `recovery-success`     | Native evaluator restart and control smoke allow the still-unexecuted action                                                                            | Candidate-image recovery with retained session/work and original deadline                  |
| `recovery-exhausted`   | Native failure/exhaustion receipts; all-provider runner outcomes and Work API failed-item proof                                                         | Combined native-to-control-plane failure, with no human assignment                         |
| `authorized-exception` | Native park/no-op records allowed at the setup-bound path on all three CLIs; foreign markers and unrelated writes denied without GitHub ownership reads | Candidate-image evidence, including unsafe-destination and multi-target patch cases        |

The ownership-change probe captures two ownership reads, two native edit
attempts, the successful first file, the absent second file, and the policy
denial delivered back to the model. Review-mode and absent/unreadable-ownership
probes also require the specific policy reason; an unrelated provider refusal
or a tool that never reaches the hook cannot satisfy them.

The review-hold probes use the actual shared GraphQL reader against a local
transport fixture. Each requires a fresh review read and the native hook;
held actions must return the specific rejection to the model without reaching
the publication transport. Holder-released actions must reach that transport.
A separate released-draft case retains an unresolved thread and must still
reject readiness. This does not claim proof of arbitrary narrative conditions.
The complete local suites pass 31 observations each on Codex 0.155.1 and
Claude Code 2.1.278, and 30 on OpenCode 1.18.25; their reports remain
`qualification: not-evaluated`, not candidate-image graduation evidence.

### Native session binding

`worker-session.cjs` consumes provider-native `session_id` metadata (OpenCode
`sessionID` is translated by its adapter), not task text. The first tool event
atomically publishes a complete `.session.json` record beside the setup context,
bound to provider/run/attempt/session. Later events must match that immutable
record. Concurrent hooks from the same session are permitted; another session
cannot replace the winner. Missing or malformed metadata, foreign attempt
environment, symlinked records, and mismatches are rejected before policy or
tool execution. This is dynamic identity enforcement, not an installation check.

Claude allocates or restores its session ID before bootstrap and supplies it
as the expected session. For runtimes that allocate an ID during startup, the
first native tool event is the binding boundary before task action. Setup
execution smokes run against an isolated temporary context/binding and never
reserve or replace the real session record. Recovery probes carry the original
native session ID. Native CLI cases verify both expected-ID mismatch and an
already-bound foreign session, including unchanged binding and absent file effects.

OpenCode's adapter resolves a distinct child session through the native plugin
SDK's `session.get` API and immutable `parentID` chain, never through task text
or tool arguments. The chain must reach the existing valid attempt root within
32 links and two seconds; missing, unrelated, cyclic, failed, or changed-root
evidence rejects the action. Verified ancestry is cached inside that adapter
instance, with the root binding revalidated on subsequent events. A new adapter
instance resolves ancestry again. No child can replace the root record.

After verification, `session_id` carries the bound root for shared policy and
recovery, while `native_session_id` retains the actual child ID. The same
mode/worktree/ownership/marker/hold policy still applies to child actions.
The provider contract is pinned to OpenCode 1.18.25's
[plugin SDK](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/plugin/src/index.ts)
and [native task parent relationship](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/tool/task.ts).

The `bootstrap-lineage` probe uses real native API-created empty child,
grandchild, and unrelated session records, then exercises the actual adapter
with their IDs. It verifies mapping, policy denial, unrelated-session rejection,
and unchanged root across adapter recreation. It launches no delegated agents:
this is provider-API/adapter integration evidence, not native delegated tool
execution qualification. `bootstrap-file-resume` separately runs the real CLI
twice with an explicit session ID, proves both file effects and an unchanged
setup binding, and shares one original probe deadline.

Claude/Codex distinct child IDs still require provider-specific ancestry support
and evidence. Combined completion correction and actual delegated execution
remain acceptance gates; do not disable legitimate delegation to manufacture
qualification.

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
- Shared policy ownership loss: the fixture reports no fleet assignee and no
  publication occurs.
- Shared policy lookup failure: a failed ownership read prevents publication.
- Bootstrap marker: the actual runner bootstrap installs and verifies the
  policy; the native loader executes it and the fixture receives the repaired body.
- Evaluator recovery: an injected in-process adapter failure is recovered by a
  fresh shared-policy process; a pre-consumed allowance prevents publication.
- Native file writes: a real linked-worktree edit succeeds; primary-checkout
  and symlink-to-primary edits are denied with independently unchanged targets.
- Mode/ownership: review-mode edits and absent/unreadable ownership are denied;
  changing ownership between two edits in one session blocks only the later edit.

Exit zero means these native behaviors were observed, **not** that the
mandatory LCARS canary suite passed. This probe deliberately reports
`qualification: "not-evaluated"`; it must not be converted to a passing
readiness report. It does not yet test completion, all recovery faults, timeout handling,
or the installed runner image as a whole. OpenCode argument repair must mutate
the existing `output.args` object: a native probe caught that replacing the
object left the original command unchanged. Policy probe cases now use the
OpenCode setup installer and verify an identical repeat is a no-op. The
installer is connected to the selected provider's runner bootstrap.

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
allowed case still executed. All twenty-two observations passed on each CLI,
including an exact repaired marker in the independently captured comment body.
The tenth observation executes a second round within the same probe deadline:
Claude retains its preallocated UUID; Codex resumes the first hook's native
session ID. Both produce a separate second-round sentinel with unchanged
session identity. This tests native resumption, not the full completion gate.
The bootstrap-marker observation uses the actual runner setup entrypoint and
independently verifies that the native loader executes its installed policy.
Two recovery observations inject an evaluator crash: successful allow/deny
smokes permit the original action, while a broken deny smoke prevents it.
Three native file observations use disposable local Git repositories and the
installed `repo-require-worktree` guard: feature writes succeed, while direct
primary and symlink-to-primary writes are intercepted. Codex uses its native
freeform `apply_patch` tool (the localhost provider selects the `gpt-5.4` tool
profile); Claude uses `Write`. Claude first reads the existing symlink target
so its own read-before-write rule does not masquerade as hook enforcement.
OpenCode runs the same three cases through its native `write` tool. These
fixtures have no remotes or user Git configuration; actual repository content
and credential state remain untouched.
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
Bootstrap installs the bridge in selected worker launch configurations; it does not
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
its execution verification before launching task work. The runner integration
does not mutate interactive workstation configuration.

The setup module also exposes `prepareWorker` (CLI: `--worker <provider>
<config> <context> <brief> <run-id> <attempt-id>`). Paths must be absolute and
distinct. It validates the trusted brief/attempt binding, writes a per-attempt
context, and installs the provider registration. Reusing that context for a
different dispatch is rejected; repeating the same setup is a no-op. The result
still reports `executionSmokeRequired: true`: registration and identity binding
alone are not permission to launch. OpenCode plugin installation preserves
unrelated entries and uses the stable package/image file URL across upgrades.

The `--bootstrap` entrypoint adds an installed-control execution smoke: invoke
the registered command or OpenCode callback with a harmless read and a known
prohibited Git action, requiring allow and deny respectively. The proposed tool
commands themselves are never executed by this smoke. A successful result
reports `controlSmokePassed: true` and `executionSmokeRequired: false`.
This proves control execution; native-loader qualification remains a separate
release prerequisite, not something these booleans certify.

`runtime/worker-policy-bootstrap.sh` is called before each selected provider's
task launch, after its effective configuration has been created. The trusted
deployment selector `LCARS_WORKER_POLICY_PROVIDERS` is a comma-separated list
of graduated providers; its default is empty (restore by unsetting it). No
provider may be added before its artifact-matched acceptance suite passes.
Selected Codex runs enable hooks and use the native trust-bypass flag exercised
by the isolated runtime probes. Setup failures or missing control-smoke proof
abort launch and retain the infrastructure diagnosis. The runner harness tests
successful binding and failed-setup/no-launch behavior for all three providers.
There is no per-tool installation-presence check.

Native Work reply dispatches remain valid. Setup can bind the runner-owned
terminal outcome path; native Write tools and a single complete Codex
`apply_patch` Add File operation may write only the exact two-line park/no-op
record for that attempt there, without requiring a code worktree. Patch updates,
deletions, moves, additional targets, and extra content cannot use the exception.
The exception neither accepts arbitrary contents nor follows symlink redirects;
missing/unreadable parents and non-file destinations receive corrective denial.
