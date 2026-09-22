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

`tools/probes/in-runner-image.mjs` runs the native probes as the image job
user against baked handlers and the baked bootstrap/completion helpers, verifying their
hashes against the candidate source first. Mount only the probe directory,
worker module directory, and the individual `worker-policy-bootstrap.sh` and
`verify-outcome.sh` and `worker-completion.sh` helpers read-only; do not mount a user
home, credentials, the complete checkout, or the Docker socket. Record the
immutable ID returned by `docker image inspect` and run that same ID with
`--network none`. Reports retain diagnostics and never claim graduation.
Also mount the source `direct-runner.sh` read-only: the wrapper checks it against
the baked runner and records its hash. Claude delegation probes read the actual
runner's literal allow/deny tool flags instead of maintaining a separate policy.

The first local candidate, source `ade85a89`, image
`sha256:4148f3409e9c30ae328ee7cf6fb976c200313d6b9bddbf7ed5979438d6c4bcfb`,
built successfully but failed the fixture's installed-worktree-guard control
before native task execution. Its worker hashes matched and its job UID was 1001. The image contained a literal dangling `/usr/local/bin/repo-*` symlink:
installing repo-tools' dependencies did not install its own package binaries.
This is failed setup evidence, not provider qualification. Repair belongs in
image installation with a build-time executable check, not a per-tool gate.
The installation now links the package's declared binaries directly from the
pinned repo-tools checkout. The final image gate verifies every link and
executes the installed worktree guard against disposable real primary and
linked Git checkouts as the job user. Regression tests reject missing commands,
non-executable targets, and guards that always allow or always deny. A rebuilt
candidate must still pass the native probes; the failed image is not qualified.

The corrected local candidate, runtime source `3aa27fa8`, image
`sha256:eb0b7b4643bd1c3033505bdd7ec8059018fc46ddd009ac3bb5cdc6ca5e79bd55`,
passed its build-time invariants as UID 1001. Codex 0.155.1 and Claude Code
2.1.278 each passed all 44 native observations against its baked handlers with
external networking disabled. These are image-bound primitive observations,
not completion of the combined workflow or every acceptance gate below.

OpenCode 1.18.25's first offline edit probe stalled during cold configuration
startup before producing a hook receipt. The pinned CLI installs
`@opencode-ai/plugin` in configuration directories on startup; the image did
not carry those prepared dependencies. The SDK installation now belongs in
the image build, matching the reviewed CLI version. The runner's existing
configuration copy carries it into attempt configuration. The native framework
smoke must run with `--network=none` using only the prepared dependencies;
isolated image probes likewise copy only SDK manifests/modules, never user
configuration or credentials. Missing native receipts now yield failed observations instead of
hiding startup diagnostics behind an attempted receipt read.

The SDK-prepared candidate from runtime source `8d4b5d43`, image
`sha256:1519bffa1e07e688b6686f57ca32bf8859c88f51d5d1607abf1c49c565754305`,
passed the real OpenCode compaction/continuation smoke without network access,
all image invariants, and the complete native primitive suites as UID 1001:
Codex 0.155.1: 44 observations; Claude Code 2.1.278: 44; OpenCode 1.18.25: 45.
The three suites ran concurrently with `--network none`, two CPUs, 2 GiB memory,
and 256 PIDs per container. Reports record matching baked worker/bootstrap
hashes and mounted harness hashes. Diagnostics were copied out of the disposable
containers. CI run `35681223251` passed full verification and full E2E for this
source. No provider is graduated; the combined workflows and separate
interactive/member-repository acceptance gates remain outstanding.

The subsequent `bootstrap-workflow` canary passed on all three pinned CLIs
against that same SDK-prepared image. Each native session edited a file, staged
and committed it, pushed the exact commit to a disposable local bare repository,
and published through a local GitHub transport. Five fresh ownership checks
occurred. The remote tree contained only the intended implementation, unrelated
untracked work remained intact, and publication carried the exact marker once.
The baked `verify-outcome.sh`, now also hash-bound in the report, rejected
completion before publication and accepted the captured artifact afterward
using its actual jq filter. Diagnostics: Codex `/tmp/lcars-image-probe-fXENf2`,
Claude `/tmp/lcars-image-probe-u1ChF6`, OpenCode
`/tmp/lcars-image-probe-H9eCJT`, copied to the host with native receipts.
The first Claude/Codex attempts correctly denied unavailable ownership because
the new fixture omitted its local transport from PATH; correcting the harness
made both pass without changing production policy. This closes the combined
happy-path evidence gap, not premature-completion correction, exhausted-budget,
delegated-child, or live-dispatch acceptance.

The combined `bootstrap-workflow-correction` and
`bootstrap-workflow-exhausted` canaries also passed on all three pinned CLIs
against the same image. Both stop after the native edit/commit/push, before
publication. The correction case executes the baked completion helper and
verifier, obtains one heartbeat from an isolated local lease endpoint, and
resumes the same native session with the actual correction prompt and the
original remaining wall-clock budget. The final artifact verifies successfully.
The exhausted case lets its original 30-second wall-clock budget expire: the
helper refuses correction, no heartbeat or second native launch occurs, and
completion remains missing. Both cases retain the exact pushed commit and
unrelated untracked work. The completion helper is hash-bound in image reports.
Correction diagnostics: Codex `/tmp/lcars-image-probe-upZlCb`, Claude
`/tmp/lcars-image-probe-ZmwAaw`, OpenCode `/tmp/lcars-image-probe-BN3pJW`.
Exhaustion diagnostics: Codex `/tmp/lcars-image-probe-7kQY8r`, Claude
`/tmp/lcars-image-probe-UEFONN`, OpenCode `/tmp/lcars-image-probe-GMsF64`.
These exercise real native continuation and the runner's helpers, not a full
production dispatch or control-plane completion. The direct-runner harness
separately covers the single-correction limit and terminal outcomes.

CI run `35683071566` failed the existing Codex bounded-completion deadline
assertion. Its log omitted the observed timeout values; the assertion now
reports them without printing prompts or credentials. A local reproduction
observed decreasing 5/3-second round limits and passed that scenario. The
assertion has not been weakened, the failure has not been rerun away, and its
root cause remains unproven pending stronger CI evidence.

OpenCode policy execution now uses the same bounded child-process bridge as
the command-hook adapters. In-process synchronous evaluation could hang the
CLI before its exception recovery ran. The bridge terminates a timed-out
evaluator with SIGKILL, so ignoring SIGTERM cannot defeat the bound; it retains
the existing single recovery allowance and allow/deny smoke. Installation and
registration still belong to setup, not per-action presence checks.
Source-level native probes with pinned OpenCode 1.18.25 passed a CPU-bound
evaluator that ignores SIGTERM: successful recovery took 5236 ms; an already
consumed allowance denied publication in 5015 ms, emitted the infrastructure
failure receipt recognized by the runner helper, and preserved unrelated work.
The combined happy-path workflow also passed with this adapter. Evidence is
in `/tmp/lcars-opencode-hook-probe-4pxS5q`,
`/tmp/lcars-opencode-hook-probe-vBytlT`, and
`/tmp/lcars-opencode-hook-probe-tk5Vhz`. Focused policy, bridge, setup, and native
session contracts passed (90 tests). The previous candidate was removed by
external cleanup, not changed or promoted; the replacement evidence follows.

`setup-boundary.mjs` adds a `setup-negative` image-wrapper scenario. For each
provider it invokes the actual bootstrap helper against malformed configuration,
a symlinked configuration, and a missing setup executable. Each must return
the explicit no-launch failure, leave the post-bootstrap launch branch
unreached, and preserve configuration and useful work. All nine source-level
checks passed with the pinned CLIs and subsequently in the replacement image.
Native Work exception probes now also reject an outcome beneath a symlinked
parent on all three providers, and reject Codex's multi-target patch combining
the outcome with an unrelated file. All four source-level native checks passed
with zero ownership lookups and independent readback of unchanged targets.
No broader write is exempted merely because a patch includes a Work result.

The replacement candidate, runtime source `a192d4d2`, image
`sha256:c4985f7fcc6c353d6f121e71acaaf3df4d53f9fd1c51c5257b25d6daae1ebc2d`,
passed its build invariants and the complete expanded native suites: Codex
0.155.1 (49 observations), Claude Code 2.1.278 (48), and OpenCode 1.18.25 (51).
Each ran as UID 1001 with external networking disabled, two CPUs, 2 GiB memory,
and 256 PIDs. Reports bind the baked modules and three runtime helpers by hash;
mounted probe hashes separately identify the harness. This includes the combined
workflow, correction/exhausted-budget cases, unsafe Work destinations, and
OpenCode evaluator timeout/recovery cases. Host-retained reports and native
diagnostics: `/tmp/lcars-image-probe-Npyk17`, `/tmp/lcars-image-probe-xTPRs6`,
and `/tmp/lcars-image-probe-54qReb`, respectively.

All nine setup-negative cases also passed against this image's baked bootstrap:
three cases per provider, with no post-bootstrap launch, explicit setup failure,
and unchanged configuration and useful work. Reports:
`/tmp/lcars-image-probe-UlHvv3`, `/tmp/lcars-image-probe-iQzzNg`, and
`/tmp/lcars-image-probe-zkLr4a`. This is the real bootstrap boundary with a
post-bootstrap launch sentinel, not a production control-plane dispatch.

Two additional Codex image canaries exercise actual native child execution.
The deterministic localhost model uses the CLI's deferred tool discovery,
`spawn_agent`, and `wait_agent`; it never fabricates lifecycle receipts. An
authorized child edit succeeds, while review mode denies the child's edit with
the corrective policy reason and no file effect. Both observe native
SubagentStart/Stop, correlate the edit's transcript with the child's lifecycle,
retain the immutable parent session/attempt binding, and preserve unrelated
unpublished work. Reports and native diagnostics were copied to the host at
`/tmp/lcars-image-probe-JdDcHe` and `/tmp/lcars-image-probe-nnyjWo`. No production
identity policy was relaxed to permit delegation. Claude/OpenCode delegated
tool execution and the remaining acceptance gates below are still outstanding;
no image was published or activated and no provider is graduated.

Source-level Claude and OpenCode native child allow/deny canaries now pass too.
Claude correlates the child's native hook `agent_id` with SubagentStart/Stop;
OpenCode correlates real task-before/task-after receipts and the native session
API's child `parentID` with the unchanged root binding. Both preserve unrelated
work and deny child edits in review mode with the expected policy reason.
Adding the runner's actual Claude flags exposed a real launch-policy mismatch:
its legacy `Task` prohibition hides the current CLI's `Agent` tool. The failed
canary at `/tmp/lcars-claude-hook-probe-lILZeH` starts no child; removing that
blanket prohibition passes at `/tmp/lcars-claude-hook-probe-QgWLYE`. Scheduling,
monitoring, and SendMessage remain disabled; the protocol still requires
synchronous work. OpenCode source evidence is retained at
`/tmp/lcars-opencode-hook-probe-Vs2sf0` and
`/tmp/lcars-opencode-hook-probe-G7HFxI`. A rebuilt image must verify the new
runner launch policy; the prior candidate was removed externally before these
new image runs started. Earlier image receipts remain retained, not superseded
by a claim of unexecuted coverage.

CI run `35685589316` failed the same deadline assertion for Claude, recording
`5, 5` seconds. A full local runner-harness reproduction passed and recorded
`5, 4` for each provider. This is not a resolved CI failure. The harness now
retains numeric worker start/end timestamps and requested sleep on failure,
without printing prompts or credentials; the shrinking-budget assertion remains
unchanged. No failed job was rerun.

The rebuilt candidate at runtime source `32531a5d`, image
`sha256:db37a3f53aea46fc915113ab7d0e474c654bc22fecdc708be1293b1bc326f1eb`,
passed setup/build invariants and all three full native suites: Codex 51,
Claude 50, and OpenCode 53 observations. These include actual delegated child
allow/deny execution for every provider, with the corrected Claude launch
policy. Reports now bind the baked direct runner by hash in addition to the
worker modules and three runtime helpers. All ran as UID 1001 with external
networking disabled and the same resource limits above. Retained reports:
`/tmp/lcars-image-probe-0tvR0F`, `/tmp/lcars-image-probe-54sUve`, and
`/tmp/lcars-image-probe-qFdYdg`, respectively. Current-head CI run
`35686314573` passed; that does not explain the earlier intermittent deadline
failure, which remains unresolved rather than rerun away.

An additional `review-acknowledgments` native suite passed all 11 cases on each
provider against that same baked image. Current-head, post-hold explanations
from the authenticated worker permit the supported draft/auto-merge action.
Stale-head, foreign-author, pre-hold, and marker-only acknowledgments reject;
valid acknowledgments do not override unresolved threads, changes requested,
or blocked labels. A worker's readiness/auto-merge event cannot release another
actor's hold. Each case requires a native tool result, the expected policy
reason for denials, exactly one actual shared GraphQL-reader lookup, and
independent transport evidence of whether the action executed. Reports:
`/tmp/lcars-image-probe-cHKN9b` (Codex), `/tmp/lcars-image-probe-umRSGl`
(Claude), and `/tmp/lcars-image-probe-9iR8jl` (OpenCode). The reports separately
hash this expanded harness. This proves the supported acknowledgment contract,
not arbitrary human-condition satisfaction or bypass-proof enforcement.
No candidate image was published or activated; no provider is graduated.

The `publication-deliverables` suite now exercises PR creation, issue comments,
PR comments, and review submissions with their correct dispatch mode and anchor.
It adds inline comment/review bodies plus ordinary body-file repair, exact-marker
idempotence, and foreign-marker rejection for all four artifact kinds. The
transport captures the body at actual publication time, including unchanged
`--body-file` commands; source body files must remain byte-for-byte unchanged.
All 22 publication checks passed on each pinned local CLI (66 observations),
including the seven existing ownership/mode/marker controls. Evidence:
`/tmp/lcars-codex-hook-probe-wGm75t`, `/tmp/lcars-claude-hook-probe-pcjolj`, and
`/tmp/lcars-opencode-hook-probe-RUZqbK`. The prior candidate is no longer present
locally; a replacement runtime-source `32531a5d` build is in progress for these
expanded image-bound checks. Local passes are not image qualification.

This ledger distinguishes native interception evidence from the complete,
image-bound scenario. No row grants provider graduation on its own.

| Scenario               | Current evidence                                                                                                                                                                   | Still required for full qualification                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `valid-work`           | All three image-baked CLIs complete a single-session edit, real commit/push, marker-repaired local publication, and actual completion verification while preserving unrelated work | Separate live-dispatch acceptance; no provider graduation from this scenario alone   |
| `invalid-identity`     | Image-bound native binding denials; all three actual native child edit/denial cases retain the root binding and useful work                                                        | Separate live-dispatch acceptance                                                    |
| `mode-violation`       | Image-bound review-mode file edits, PR creation, and actual Git pushes reject with corrective reason                                                                               | Separate live-dispatch acceptance                                                    |
| `ownership-lost`       | Image-bound absent/unreadable ownership denies; two-tool sessions preserve the first edit/publication and deny the second after ownership changes                                  | Separate live-dispatch acceptance                                                    |
| `primary-worktree`     | Image-installed guard and native direct/symlink-to-primary edits deny; real Git push succeeds only from linked checkout                                                            | Separate live-dispatch acceptance                                                    |
| `missing-marker`       | Image-bound native repair, exact-marker idempotence, and foreign-marker denial                                                                                                     | Full supported-deliverable coverage                                                  |
| `premature-completion` | All-provider image-bound workflow correction resumes the same session within its original deadline; exhaustion preserves work without resuming                                     | Production control-plane dispatch acceptance                                         |
| `review-hold`          | Image-bound held/released actions plus all-provider current-head acknowledgments, invalid acknowledgment denials, independent review gates, and self-release rejection             | Separate live-dispatch acceptance; arbitrary human conditions are not machine-proven |
| `missing-hook`         | Native bootstrap installs omitted registration; all nine image-bound negative setup cases refuse launch and preserve configuration/work                                            | Fresh workstation/member-repository convergence gates                                |
| `hook-failure`         | Image-bound thrown failures and native timeouts deny; OpenCode ignores SIGTERM, is killed within the bound, and preserves work                                                     | Combined native-to-control-plane infrastructure outcome                              |
| `recovery-success`     | Image-bound evaluator restart and control smoke allow the still-unexecuted action                                                                                                  | Combined recovery with retained session/work and original deadline                   |
| `recovery-exhausted`   | Image-bound failure/exhaustion receipts; separate all-provider runner outcomes and Work API failed-item proof                                                                      | Combined native-to-control-plane failure, with no human assignment                   |
| `authorized-exception` | Image-bound park/no-op records allowed only at setup-bound path; foreign/unrelated, unsafe destination, and Codex multi-target writes denied without ownership reads               | Separate live-dispatch acceptance                                                    |

The ownership-change probe captures two ownership reads, two native edit
attempts, the successful first file, the absent second file, and the policy
denial delivered back to the model. Review-mode and absent/unreadable-ownership
probes also require the specific policy reason; an unrelated provider refusal
or a tool that never reaches the hook cannot satisfy them.

The `bootstrap-publication-*` probes submit literal `gh pr create` commands
through the native command tool in a real linked worktree. Their local GitHub
transport records publication independently of the hook. Authorized creation
must retain its body and receive the exact attempt marker; review-mode,
unclaimed, and unreadable-owner cases must not reach publication. The changed
owner case permits one publication, changes the fixture ownership after its
tool result, and requires the second publication to be rejected with two fresh
ownership reads and the first artifact preserved. A mode violation takes
precedence over marker repair so a review worker is told to submit its review,
not to retry an unauthorized PR creation with a different body.

The `bootstrap-push-*` probes use actual Git, a disposable linked worktree,
and a local bare remote without credentials or network publication. They read
the remote ref and compare its commit ID with the source HEAD. Review-mode,
primary-checkout, absent-owner, and unreadable-owner cases must leave that ref
absent. A two-push case changes ownership after the first tool result, retains
the first remote ref, and requires the second ref to remain absent. Every case
also verifies that an unpublished work file remains unchanged. Disabling the
mode rejection makes the native review-mode probe fail with an observed remote
write; a hook invocation or a provider's success message alone cannot pass it.

The review-hold probes use the actual shared GraphQL reader against a local
transport fixture. Each requires a fresh review read and the native hook;
held actions must return the specific rejection to the model without reaching
the publication transport. Holder-released actions must reach that transport.
A separate released-draft case retains an unresolved thread and must still
reject readiness. This does not claim proof of arbitrary narrative conditions.
The baseline complete local suites pass 42 observations each on Codex 0.155.1 and
Claude Code 2.1.278, and 43 on OpenCode 1.18.25; their reports remain
`qualification: not-evaluated`, not candidate-image graduation evidence.
Two additional focused native publication cases pass on each version: an
already-correct marker remains byte-for-byte unchanged and occurs only once;
a foreign claim gets corrective rejection, no publication, and no ownership
lookup. Image reports also record the mounted probe-file hashes, since the
test harness may advance independently of unchanged baked worker handlers.

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

Native API execution errors and invalid API response shapes are distinct from
valid evidence of unrelated ancestry. An API failure consumes the same atomic,
attempt-wide recovery allowance as evaluator recovery and retries the complete
native lookup once. Each lookup remains bounded to two seconds. A recovered
lookup must prove the chain before the action can proceed; a recovered policy
denial remains denied. Exhaustion writes the existing infrastructure-failure
receipt, preserves work/root binding, and never fabricates a human blocker or
PARK. Restarting the adapter cannot reset the allowance. The native recovery
fixtures also run the actual runner failure-classification helper against these
receipts; they still do not claim full delegated-agent or image qualification.

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
- Evaluator recovery: an injected evaluator-process failure is recovered by a
  fresh shared-policy process; a pre-consumed allowance prevents publication.
- Native file writes: a real linked-worktree edit succeeds; primary-checkout
  and symlink-to-primary edits are denied with independently unchanged targets.
- Mode/ownership: review-mode edits and absent/unreadable ownership are denied;
  changing ownership between two edits in one session blocks only the later edit.

Exit zero means these native behaviors were observed, **not** that the
mandatory LCARS canary suite passed. This probe deliberately reports
`qualification: "not-evaluated"`; it must not be converted to a passing
readiness report. It now covers combined completion and bounded evaluator
timeouts, but not all recovery faults or a full production dispatch. OpenCode argument repair must mutate
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

### Member-repository inventory checkpoint (2026-09-21)

The checked-in console admission and watched-repository lists in
`apps/console/apphosting.yaml` both name the same seven repositories; the
label-contract audit matrix agrees. All seven have available local checkouts.
This is a discovery checkpoint for #2031, **not a completed instruction or
behavior audit**, and not proof of remote or deployed convergence.

| Repository                       | Local checkout                     | Observed revision | Discovered instruction / hook entry points                                                             |
| -------------------------------- | ---------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| `jlapenna/agent-lcars`           | `/home/jlapenna/p/agent-lcars`     | `4397a9bb187d`    | `AGENTS.md`, `CLAUDE.md`, Claude settings/local settings, Codex hooks, `agents/opencode/opencode.json` |
| `jlapenna/homelab`               | `/home/jlapenna/p/homelab`         | `db2132d24fb0`    | `AGENTS.md`, `CLAUDE.md`, `.agents/AGENTS.md`, Claude settings, Codex hooks                            |
| `supersprinklesracing/sprinkles` | `/home/jlapenna/p/sprinkles`       | `d8693b529401`    | Root and CLI/Primes instructions, Claude local settings                                                |
| `supersprinklesracing/www`       | `/home/jlapenna/p/www`             | `c590a2ca9938`    | `AGENTS.md`, Claude settings, Codex hooks                                                              |
| `supersprinklesracing/girosf`    | `/home/jlapenna/p/girosf`          | `b1f9f83741cb`    | `AGENTS.md`, Claude settings, Codex hooks                                                              |
| `jlapenna/nx-cache-server`       | `/home/jlapenna/p/nx-cache-server` | `d7f40064ab7d`    | `AGENTS.md`, Claude settings, Codex hooks                                                              |
| `jlapenna/sync-padd`             | `/home/jlapenna/p/sync-padd`       | `f08543b4f5d2`    | `AGENTS.md`, Claude settings, Codex hooks                                                              |

Remaining coverage: read applicable skills and referenced instructions; trace
generated/shared registrations to their source; inspect ignored or externally
managed effective configuration; exercise interactive/dispatched behavior; and
record findings and fixes through each repository's normal workflow. No member
repository was edited or marked clean by this inventory pass. #2031 remains open.

Subsequent local checks on pike confirmed that the PATH-installed
`fleet-codex-issue-guardrail` resolves through its pnpm shim to a handler
byte-identical to this repository's `codex-issue-guardrail.cjs` (SHA-256
`6a573a9826ef690733056e7f75b8888fc1c388cd6d06ea84a0bd9edfa013edea`).
The handler's 45 tests pass, including interactive silence with generic CI
flags and provider session IDs. Homelab's reminder hook was also exercised
directly: an issue read and reading a deploy script produce no context; a
deploy-command input produces only the canonical-checkout reminder. No actual
deployment command was run. This narrows the local hook audit; it does not
establish fresh interactive-session behavior, all-account convergence, or
installation on another workstation.

### Interactive account checkpoint (2026-09-21)

Homegit inventory at Homelab revision `db2132d24fb03940199839842a3babb2e25858b9`
declares the following accounts. The canonical read-only account inspector ran
over SSH as each declared user. All were reachable, with clean `main`, matching
credential-free origin, inactive legacy writers, and `auto_apply: true`.
All five source checkouts matched current Homegit `main`,
`633abeba85a2116b6a6d540c39a9326492cc952e`. Relevant destination checks found zero
global Codex ownership-hook commands and the identical corrected shared workflow
skill SHA-256 `49a5a0aba443caa72ed355cf33f6926c8f6af85cf8e108ef6251cc6118a45edf`.

| Account            | Inventory reachability class   | Fleet-tools inspection                                 |
| ------------------ | ------------------------------ | ------------------------------------------------------ |
| `laptop/jlapenna`  | Transient, currently reachable | Not found in checked standard package/bin locations    |
| `pike/jlapenna`    | Permanent                      | Installed guard matches the verified source hash above |
| `homelab/homelab`  | Permanent                      | Not found in checked standard package/bin locations    |
| `laforge/jlapenna` | Permanent                      | Not found in checked standard package/bin locations    |
| `janeway/jlapenna` | Permanent                      | Not found in checked standard package/bin locations    |

Pike's installed module passed 14 focused open/closed-issue and dispatch-marker
checks with injected lookups: interactive/generic-CI/provider-ID contexts made
zero lookup calls; each explicit dispatch marker retained ownership/routing
feedback. The installed CLI silently ignored malformed input without dispatch
context. No real GitHub query or write was made by these probes. This is
installed-module/CLI evidence, not a fresh full agent session. No account was
changed, no reconciliation gate was enabled, and no agent was restarted.
Alternate installation locations and fresh harness behavior remain unverified;
Homegit #82 and LCARS #2032 are not closed by this checkpoint.

The Sprinkles instruction correction is separately committed locally as
`e37dd9e960063575a6525279a7c6b8c15d5083c3` in its dedicated worktree. Publication
was blocked by an unrelated pnpm/sandbox version mismatch; approval to alter
that pin has not been received. It is not published or counted as delivered.

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
