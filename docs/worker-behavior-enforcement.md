# Dispatched-worker behavior enforcement

Status: implemented interception and isolated canary harnesses; **no provider is
graduated and production activation is not authorized**. The source default for
`LCARS_WORKER_POLICY_PROVIDERS` remains empty. Dated observations below are
historical evidence, not a readback of current production configuration. The
folded image qualification ledgers and dated acceptance checkpoints live in
[#2181 (comment)](https://github.com/jlapenna/agent-lcars/issues/2181#issuecomment-6257748989).

## Current qualification boundary

Track completion in [#2181](https://github.com/jlapenna/agent-lcars/issues/2181).
The shared policy, provider adapters, setup smoke, attempt/session binding,
marker repair, review-hold reader, evaluator recovery and runner classification
exist. Native suites exercise useful edit/commit/push/publication, forbidden
actions, correction and retained work with a localhost model and local
transports. Those are isolated runtime observations, not real policy-enabled
dispatches.

| Evidence level   | Established                                                                                             | Remaining                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Source/contracts | Shared controls, provider launch integration, explicit disabled Job selector and failure classification | Ready-head CI and independent review for changed live contracts                                                                            |
| Isolated image   | Claude 78+3, Codex 79+3 and OpenCode 81+3, evaluator and failure consumer at the candidate linked below | Changed artifacts need fresh provider evidence; offline success does not graduate a provider                                               |
| Real dispatch    | Normal Codex review of #2029 and useful policy-off Claude report for #2845                              | Useful policy-enabled implementation/review dispatches with the candidate image, preserved work and exact-marker deliverables per provider |
| Activation       | Default is off; no deployment or selector mutation is performed here                                    | Specific maintainer approval and Homelab-owned activation, observation and rollback                                                        |

The [current ordinary-CI qualification receipt](https://github.com/jlapenna/agent-lcars/issues/2181#issuecomment-6277415491)
binds all three provider suites to source `987d0f43abcb127e4f1536d8c91883bc30e99983`
and immutable image index
`sha256:54760b9bc082868263725fbdcbd07970b5a552f29d9fe059a2ef65fd3e30693e`.
Each actual runner/Pod image binding was verified on ARM64 as UID 1001. All
native cases, three setup-negative cases and the typed failure consumer passed
per provider; normal artifacts and their verified digests are retained. This
completes isolated qualification for that candidate, not policy-enabled dispatch
or production activation.

The [2026-10-17 useful-work receipt](https://github.com/jlapenna/agent-lcars/issues/2181#issuecomment-6228476076)
binds Claude CLI 2.1.302, Work `01M53SRA2AE75PY9PAWNA9MT1S/r1`, its actual
ARM64 Pod and normal published image index
`sha256:6769b237e7164419c71b734aba3d7d39bb09d40bcc0dfcd7d264b26cd07acb8e`
to source `6a3cc432ae4a8b3d5fbcf44a8683a68f862e17c5`. The useful report finished
`done` / `report` / `ok:true` with policy off. It qualifies that provider execution,
not enabled-policy behavior, the native/setup/failure-consumer suites, another
provider or a later candidate image. The private-engine incident and its recovery
are separately owned by #2848; replacing that retired facility is not a provider
graduation prerequisite when an existing supported native carrier can perform
the qualification.

The source inventory contains 78 Claude, 79 Codex and 81 OpenCode native
observations, plus three setup-negative cases per provider. Inventory lives in
`tools/probes/qualification-modes.mjs`, consumed by execution and the evidence
gate; selective passing reports cannot satisfy it. See the
[qualification and bounded rollout artifact](worker-policy-rollout.md) for
independent commands, provenance, metrics and approval targets.

The [2026-10-09 source evidence record](worker-policy-source-evidence-2026-10-09.json)
retains every passing mode, sanitized phase timing, exact CLI versions and
source/module/helper/harness hashes: Claude **78/78**, Codex **79/79**, OpenCode
**81/81**, plus **3/3 setup-negative cases each**. It also retains the initial
Codex catalog failures and pre-fix Claude/Codex exhaustion failures. The raw
runner-local directories are temporary; the committed record does not claim
an inspected image identity, complete durable fixture bundles or a live dispatch.
That source-only record does not establish candidate-image qualification or
failure consumption.

The [accepted Codex offline receipt](https://github.com/jlapenna/agent-lcars/issues/2181#issuecomment-6256439638)
binds Work `01M58GRR662DGGDBB72VNJ2QYP/r1`, source
`37ceafcbc015eb254cc029d239d6248303026525`, CLI `codex-cli 0.163.0` and imageID
`sha256:d714279ad545542f927d4aa53c56e4488bcbd24db737928c10b65156c00db6bc`.
All 79 native cases, three setup-negative cases and both typed failure-consumer
controls passed. The complete source/baked bindings, full durable fixture
archive and positive original-container exit-0 receipt were verified. The
receipt retains the receiver's initial mode-comparison failure, the outer
worker's credential-output violation and the limits of the byte-only custody
ACK; it does not credit the whole outer run as procedurally compliant.
The evaluator remains `offlinePassed: true`, `graduated: false` and
`activationAuthorized: false`. This qualifies that exact Codex offline evidence,
not another image/provider or policy-enabled dispatch. The ordinary-CI receipt
above supplies the later three-provider qualification without changing this
historical result.

The earlier 2026-10-18 in-job Codex run adds partial observations, not complete
qualification evidence. Work `01M5666ND109DH80NVB9AN2WRQ/r2` ran as UID 1001
with equal 2 CPU/6Gi/24Gi requests and limits on ARM64, at source
`0a100485a47a9fe44ae6161360fb8ea4396bb990`. The allocation's inspected Pod
imageID was
`docker-registry.lan.jlapenna.net/homelab-runner@sha256:2e0cf0c1310626fe52cb8d47cd1d74808c6fb0b64d62b03feedbda2234ebf564`
(manifest/config distinction unverified), with CLI `codex-cli 0.163.0`.
Native logs record both wrappers returning exit 0 and reporting 79 native and
3 setup-negative cases passing against image-baked handlers. The complete
40-input group checks matched, the evaluator reported
`offlinePassed: true, graduated: false, activationAuthorized: false`, and the
correctly invoked failure consumer passed one test using the native report.
Earlier consumer invocations failed; the final passing log overwrote the
complete failed consumer log, while their actual tool outputs remain in the
normal private provider archive. These are in-process consumer checks of the
production code paths, not live production dispatch evidence.

The probe commands inherited the outer environment and HOME instead of the
required `env -i` and isolated HOME boundary. Isolation is therefore
unqualified; the reported behavioral passes do not retrospectively prove it.
The uploaded partial bundle is asset `652145397` on draft release `416141863`,
133302 bytes with reported server digest
`sha256:2bd9cd8c1f77206c4c912178792683f0b478e043ac3dde8d1df0040b03725249`.
It contains the two wrapper diagnostic directories but omits the separate
`nativeReport.evidenceDirectory` fixture/dependency trees, the required phase
and exit records, and version stderr. It is not a complete untrimmed bundle;
independent semantic verification and the complete private raw/index export
were not established. The omitted in-Pod evidence was not recovered before
the exact Job and Pod became absent, so full retention remains unqualified.

The canonical provider clock starts at `2026-10-18T01:31:01.740Z`; the run
finished at `2026-10-18T01:45:28.068Z`. Its uploaded local binding record's
`01:30:58Z` start is not that canonical timestamp. The later Codex result does
not repair this earlier run's isolation or incomplete retention. Useful
policy-enabled dispatch and activation remain separate unqualified gates.
No graduation or activation is authorized.

The native fixture uses one monotonic budget across initial execution,
correction, explicit resume and failure finalization. Its 30/60-second limits
and denial assertions are unchanged. The source run exposed a separate fixture
clock issue: Codex and Claude exhaustion observations failed with `Date.now()`;
all three targeted observations pass with the shared monotonic budget. This
fixture correction is separate from the adopted production budget below.

Codex's localhost model fixture supplies an isolated `model_catalog_json` with
its expected tool metadata. The current CLI no longer includes the fixture's
old model name in its bundled catalog; the initial authorized-edit probe failed
without `apply_patch` metadata. The scratch catalog corrects the fixture, with
no production model configuration change. See the [official config reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The shared provider budget now uses monotonic `/proc/uptime` deadlines.
[#2223](https://github.com/jlapenna/agent-lcars/issues/2223) is closed: deterministic
clock, correction, credential-wait and verifier controls passed, and the adopted
runner image `sha256:42dac0f2ece61b34e280ee7d155f44dae45608d80d2eafa4dd805e6ef5489eae`
is bound to source `3d6492a8366f71566867302521cc7de72a37c33c`, including the
monotonic-budget fix. One real OpenCode run, #2325/r2, completed useful work under
the observed 7200-second timeout. This establishes adoption of that budget;
it does not establish a live wall-clock-step experiment, deadline exhaustion or
policy-enabled provider graduation. The retained wall-clock CI failures and
[#2217](https://github.com/jlapenna/agent-lcars/issues/2217)'s diagnostics remain
historical evidence. The host-clock investigation remains independently owned by
[Homelab #2186](https://github.com/jlapenna/homelab/issues/2186).

The later [#2409](https://github.com/jlapenna/agent-lcars/issues/2409) provider
OS-spawn clock wrapper is present in source
`8aec097bb898fde306f09cacd768a553f74f66e8`; the observed `42dac` runner predates
it, so source delivery does not establish adoption of that wrapper. Likewise,
the controller observed on 2026-10-10 runs source
`9a4badfa89c008f4c0f7cae4e1d30bc40dd1cdd9`.
[#2273](https://github.com/jlapenna/agent-lcars/issues/2273) and
[#2275](https://github.com/jlapenna/agent-lcars/issues/2275) retain the separate
controller-adoption gates for token refresh and terminal-run retention. Their
source fixes landed in [#2264](https://github.com/jlapenna/agent-lcars/pull/2264);
Console deployment does not deliver the controller binary. The production policy
selector default remains empty. Isolated candidate qualification does not
establish useful policy-enabled dispatch or approved activation.

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

| Mandatory requirement             | Implemented owner                                                                 | Qualification boundary                                                              |
| --------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Attempt/session identity and mode | Setup context, native session/child binding, pre-action mode rejection            | Current image and real dispatch; child receipts do not permit background work       |
| Fresh ownership                   | Supported edit/Git/publication interception reads current ownership               | Current image plus normal dispatch; indirect/API/MCP writes remain outside coverage |
| Worktree protection               | Installed repo-tools guard; native primary/symlink denials and linked Git writes  | Current image guard and member/workstation acceptance                               |
| Deliverable and completion        | Marker repair, actual verifier, one same-session correction, native Work outcomes | Monotonic shared budget (#2223) and normal control-plane dispatch                   |
| Ready/auto-merge holds            | Paginated reader and event/head-bound acknowledgments                             | Current image and live holds; arbitrary human conditions still need judgment        |

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

### Image qualification probe

`tools/probes/in-runner-image.mjs` runs the native probes as the image job
user against baked handlers and the baked bootstrap/completion helpers, verifying their
hashes against the candidate source first. Mount only the probe directory,
worker module directory, and the individual `worker-policy-bootstrap.sh` and
`verify-outcome.sh` and `worker-completion.sh` helpers read-only; do not mount a user
home, credentials, the complete checkout, or the Docker socket. Record the
immutable ID returned by `docker image inspect` and run that same ID with
`--network none`. Reports retain diagnostics and never claim graduation.
Every probe removes its temporary root when it passes and keeps it (printing
the path to stderr) when it fails; pass `-e LCARS_PROBE_KEEP_EVIDENCE=1` to keep
a passing run's reports for the release-qualification consumer below
(`tools/probes/scratch.mjs`).
Also mount the source `direct-runner.sh` read-only: the wrapper checks it against
the baked runner and records its hash. Claude delegation probes read the actual
runner's literal allow/deny tool flags instead of maintaining a separate policy.

Probe drivers retain execution start, first output, exit, close, deadline and
host-pressure evidence for every launch, including correction and resume
attempts; a timeout kills the process group at the deadline, and printed output
or an exited parent with inherited pipes cannot turn it into success. Qualify
on isolated, adequately provisioned test storage; do not extend deadlines,
disable database durability, or change production worker storage to hide
contention ([#2048](https://github.com/jlapenna/agent-lcars/issues/2048)).

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
Exit 0 means the supplied readiness report is internally complete and artifact-matched;
exit 1 means it is not. This is not provider graduation or activation approval.
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

1. Land source controls and their required contracts, with independent review of
   live runtime/deployment boundaries. Resolve shared prerequisites such as #2223.
2. Qualify each candidate provider independently with the complete native and
   setup-negative image suites and retained immutable artifact identities. Run
   that provider's native failure-chain consumer; do not graduate it from offline
   observations alone.
3. Obtain approval for the exact candidate executor scope, then prove useful
   normal policy-enabled dispatch, finalization and remaining interactive/member
   acceptance. Retain existing skills for uncovered paths and judgment.
4. Graduate only a provider whose mandatory artifact-matched and live gates have
   passed. Another provider's failure does not erase its evidence or require
   weakening a control.
5. Obtain specific production activation approval and apply the bounded
   [observation/rollback plan](worker-policy-rollout.md). Remove superseded prose
   only after the corresponding executable replacement has passed acceptance.

## Native OpenCode boundary probe

Run the real executable against a deterministic localhost model:

```sh
node tools/probes/opencode-hook-boundary.mjs /absolute/path/to/opencode 1.18.25
```

The version must match exactly. The runner's pin is in
`apps/runner-autoscaler/runner-image/opencode-version`; local results from
another version are diagnostic only. The probe creates isolated temporary
homes/workspaces and uses an allowlisted environment without real credentials.
It writes stdout, stderr, hook receipts and observations under the printed
temporary directory, which it removes on a pass and keeps on a failure; set
`LCARS_PROBE_KEEP_EVIDENCE=1` to keep a passing run's directory. It never publishes GitHub artifacts or changes global
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
