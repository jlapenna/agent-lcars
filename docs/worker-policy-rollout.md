# Worker policy qualification and bounded rollout

This is the review artifact for [#2181](https://github.com/jlapenna/agent-lcars/issues/2181).
It authorizes no publication, deployment or production selector change. Homelab
owns those operations; Agent LCARS owns the executable controls and their
[coverage limits](worker-behavior-enforcement.md#initial-policy-coverage-not-enabled).
A provider passes independently. Offline success never means graduation.

## Candidate qualification

The monotonic budget/fence prerequisite
[#2223](https://github.com/jlapenna/agent-lcars/issues/2223) is closed, with
deterministic clock/correction controls and actual runner adoption qualified.
See the [current budget and fleet-adoption boundaries](worker-behavior-enforcement.md#current-qualification-boundary)
for the immutable image/source binding and the later provider OS-spawn clock
wrapper's separate adoption gate. Keep
[#2217](https://github.com/jlapenna/agent-lcars/issues/2217)'s retained diagnostics
and [Homelab #2186](https://github.com/jlapenna/homelab/issues/2186)'s clock
investigation separate. A previously qualified image does not qualify a changed
candidate, and offline canaries cannot authorize activation.

Agree on the reviewed source revision with the platform owner before any image
publish. Follow [canonical image publishing](image-publish-routing.md). Record
the candidate's immutable registry digest, local inspected image ID, build
source SHA and baked CLI versions; retain publisher provenance and scan results.
Do not promote a mutable fleet tag as a qualification shortcut.

### Ordinary CI execution

The manual `Worker policy qualification` workflow runs one provider's existing
native suite, setup-negative suite, image-evidence evaluator and typed failure
consumer directly in an ordinary `agent-lcars-ci` allocation. It uses the normal
Node/pnpm setup and GitHub Actions artifact upload. It does not dispatch another
AI worker, create an external receiver, reserve a dedicated host or change the
production policy selector. Other jobs continue through normal Kubernetes
scheduling. The generic worker size is a platform-owned setting, not a memory
or disk requirement of these tests.

After the workflow reaches the default branch, the qualification owner supplies
its expected immutable image ID and selects the provider, for example:

```bash
gh workflow run worker-policy-qualification.yml \
  -f provider=claude -f candidate-image-id="$candidate_id"
```

Use a separate invocation for OpenCode. Do not repeat already-accepted Codex
qualification for an unchanged candidate merely to produce a newer report.
The CLI version is measured from the runner. The existing wrapper checks the
image-baked handlers and runtime against the checked-out source, and the
existing evaluator requires the complete provider mode inventory. The failure
consumer uses the same native report; no synthetic replacement is generated.
Every command has a bounded timeout and retained stdout, stderr and exit code;
the job stops on the first failure without repeating a phase.
On failure, a 15-second exit trap copies existing raw stdout/stderr and JSON/JSONL
fixture diagnostics into `failed-diagnostics/`, preserving their scratch-relative
paths and full contents. It also collects partial files available after an early
failure or phase timeout. Dependency/Git directories and symlinks are excluded.
`execution.exit` preserves the original failure; `collection.exit` and collection
logs separately report any copy failure or timeout. The ordinary artifact uploads
these diagnostics with the phase logs.

The candidate image ID is operator-supplied expected identity, not an OCI
inspection performed by the worker. `qualification.json` records
`imageIdentityVerified: false` and `qualificationAccepted: false`. Before
accepting candidate-image qualification, the owner must bind the workflow
run/attempt and actual runner name to the normal runner Pod's immutable image
identity using the existing platform read route. A green workflow alone does
not prove that external binding or authorize graduation or activation.

The normal artifact contains version output, native/setup reports, evaluator
output, consumer output and phase exit codes, with source/baked hashes and
workflow/runner identity. Passing scratch trees use their existing cleanup;
copying dependency trees, collecting whole fixture archives, byte-custody ACKs
and a separately qualified receiver are not prerequisites for this CI path.
Historical complete archives and original failures remain unchanged. Failed
commands retain their actual logs; a failed or canceled workflow is not passing
qualification and must not be retried into green.

### Local Docker alternative

From a clean committed source worktree and a Docker host with the candidate
already present, run each provider independently. Set `candidate_id` to the
exact `sha256:` ID returned by `docker image inspect`; use a fresh output path:

```bash
node tools/probes/qualify-worker-image.mjs claude "$candidate_id" /tmp/policy-claude-candidate
node tools/probes/qualify-worker-image.mjs codex "$candidate_id" /tmp/policy-codex-candidate
node tools/probes/qualify-worker-image.mjs opencode "$candidate_id" /tmp/policy-opencode-candidate
```

These commands never build, pull, publish or deploy. Each records the source
commit, actual image CLI version, baked module/helper/runner hashes and mounted
harness hashes. Each uses UID/GID 1001, no external network, two CPUs, 2 GiB
memory and 256 PIDs. The only mounts are read-only probe/module directories and
individual runner/helpers; no credentials, home, full checkout or Docker socket
enter the container. Fixture storage is the container's `/tmp`; record Docker
storage/host identity with the release evidence and investigate contention
instead of extending deadlines.

The same native suites can instead be measured from inside one normal admitted
LCARS Job with `tools/probes/in-runner-image.mjs`, which refuses to run as root,
requires the inspected `sha256:` image ID supplied by an operator allocation
receipt, and fails closed when any image-baked module, runtime helper or the
direct runner differs from the checkout — no copies enter the image. Retain its
bundle the same way; see the partial 2026-10-18 in-job Codex observation in
[worker-behavior-enforcement](worker-behavior-enforcement.md#current-qualification-boundary).

Inside that allocated Job, one deterministic command replaces manual phase
sequencing:

```bash
node tools/probes/qualify-worker-image.mjs --in-runner codex \
  /run/lcars-qualification/allocation-receipt.json \
  /run/lcars-qualification/source-contract.json /tmp/qualification-runs
```

The receipt is the Root-authenticated allocation record (provider, inspected
image ID, run ID, hostname/arch, UID 1001, cgroup CPU/memory actuals, canonical
provider start/expiry); the contract is the approved source/artifact binding
(source commit, provider version, the fourteen baked module/helper/runner
hashes, and the complete current probe-harness and failure-consumer hashes).
The trusted allocation owner must provision both inputs as root-owned regular
files, with no group/other write permission, under root-owned directories with
no group/other write permission (for example `/run/lcars-qualification`). Symlink
components and runner-writable ancestors, including `/tmp`, are refused. The
runner must not create its own approvals: root provisioning attests the inspected
image identity and approved source; the command does not independently inspect
the container image. This source change does not provision or qualify a Job.
Receipt and contract are opened through pinned directory descriptors, checked
before use, and each read once; parsing, SHA-256 identity and retained
child copies use those same bytes even if the input paths are later replaced.
The command refuses closed on any mismatch — wrong user, host, arch, cgroup,
clock or hash. It claims `<runs>/run-<32-hex>` exclusively with `intent.json`. That basename is the
SHA-256 of `lcars-run:v1:<run-id>` truncated to 32 hex characters: the canonical
run id contains `:` and `/`, which a basename must never smuggle as a path
separator. A repeated invocation against that root can only re-read
a validated terminal outcome, never start a second entry. Reread requires an
owned non-symlink directory and regular owned journals/completion objects,
current provider/run/image identity, exact receipt/contract and input digests,
the original admitted monotonic deadline, consistent phase/qualification/status
records and the final inventory. Missing, malformed, stale or contradictory
evidence refuses without adopting, overwriting or deleting the existing root.
Every invocation, including a completed reread, still requires an unexpired
allocation receipt before any writer or spawn. The stored deadline is never
renewed. A validated failed run stays failed. Inside the original provider clock
the detached child first verifies the approved Git HEAD, source hashes, and a
clean committed checkout with Git status, covering transitive setup/install
inputs without a separate path list. Any staged, modified, deleted, or
nonignored untracked source refuses before setup. Only untracked evidence
inside this exclusively claimed run root is exempt; tracked changes there
still refuse. Normal Git ignores continue to cover generated dependencies and
cache outputs. The child then runs setup first — `tools/setup-worktree.sh` once, then the
baked CLI version once, the full native suite once,
the setup-negative suite once (both through the unchanged driver with `TMPDIR`
set to the run's owned `fixtures/` root and `LCARS_PROBE_KEEP_EVIDENCE=1`), the
existing `evaluateImageEvidence` binding, and exactly one genuine typed failure
consumer. It stops at the first failure and never repeats a phase.

The run root keeps every journal (`intent.json`, `child.json` with PID and
proc birth, `phases.json` with per-phase invocation, deadline, exit and
recording stats, raw `*.stdout.bin`/`*.stderr.bin` logs), `expected.json`, both
raw image reports, `qualification.json`, the fourteen retained baked input
files under `retained/baked/`, complete fleet-tools and runtime directory targets
under `retained/fleet-tools/` and `retained/runtime/`, all fixture descendants under `fixtures/`
(never filtered by name), and `index.json` — every root entry's dev/ino/UID/
mode/size/role, including symlink lstat identity and textual target. Directory
pointers are certified only after their complete target copy succeeds. Copied
symlinks retain their original absolute target meaning so relocation cannot
misclassify an escaping relative pointer as owned; escaping
links in either copy still make retention incomplete. Advertised scenario diagnostic and nested evidence paths must be inside the
run root; an outside or malformed pointer stops the run before evaluation,
with the complete recorded report preserved. Absent optional pointers are
allowed. Filesystem links escaping the root still use the retained-copy
classification above. `index.json`
also carries `nestedRetirement`. Killing the wrapper's process group cannot
certify that the provider group its driver started has stopped, so any phase
that did not report its own exit — timeout, signal, or spawn failure — records
`nestedRetirement: "unknown"` in `index.json` and `qualification.json`, names
the phase in `qualification.json.unknowns`, and forces
`retention: "incomplete"` even when every pointer is otherwise retained. Only a
phase that reported its own exit leaves it `"confirmed"`. Unknown nested
retirement is an evidence-retention statement, not operator retirement
permission: every preserved file stays, and acceptance and cleanup stay the
separate operator gate below.
Completion finalization creates an exclusive 0600 `.status.pending` and
`index.json`, inventories both final inodes/UIDs/modes/byte sizes (mapping the
pending inode to `status.json`), and fixes the index's own byte size within at
most four serialization passes. The index binds status bytes and identity/
completion journals with SHA-256. Staged status also binds a canonical semantic
digest of retention, external pointers, nested retirement and per-link retained
flags, produced with the actual collected roots. Finalization rechecks it after
the inventory walk and immediately before publication; completed reread compares
the stored digest without reconstructing roots from untrusted retained labels. Its explicit `selfContentHash` exclusion
applies only to `index.json` content, avoiding a circular self-hash; its final
self metadata is still exact. After flushing the staged status and final index,
an atomic rename publishes `status.json` last. Failure or interruption before
publication retains incomplete evidence without a visible successful status;
there is no retry, overwrite or cleanup of that root.
For a passing run, the original monotonic provider deadline is checked again
after the final inventory walk, immediately before that rename. Expiry during
the walk leaves the index and staged evidence intact without publishing status.

`qualification.json` separates the local probe outcome from acceptance:
`localProbePassed` reports the measured result, while
`durableCollectionComplete`, `qualificationAccepted`, `cleanupAuthorized`,
`graduated` and `activationAuthorized` stay `false` until the operator
separately collects the bundle, performs semantic review and Root ACK — the
same remaining gates as the Docker route, whose interface is unchanged.

The full native suite and all setup-negative cases must pass exactly once;
missing, duplicated, failed, partial, wrong-user or mixed-artifact observations
fail. The host output includes `expected.json`, `qualification.json`, both raw
image reports, stdout/stderr and native fixture diagnostics. Retain the whole
bundle in the operator's approved artifact store. Every Docker client has hard signal termination. Owned containers are named
before creation, including disconnected-create paths; one monotonic 15-second
cleanup budget reserves time for termination and stopped-state proof even when
inspection hangs. SIGTERM/SIGINT/SIGHUP interrupts the active client and awaits that
cleanup without cancelling cleanup subprocesses on a second signal; abrupt host/process death still requires operator inspection. Failed or unproven cleanup cannot report success. A failed
collection prints the retained container ID; collect its fixture diagnostics
before removing it. Complete native fixture diagnostics are required, not
optional.
Only local model/transport fixtures appear there; do not add real credentials
to these probes.

An exit-zero `offlinePassed` result still reports `graduated: false` and
`activationAuthorized: false`. It is deliberately not a `worker-readiness.cjs`
runtime report. The legacy readiness evaluator trusts supplied references;
the operator must verify retention, authenticity, artifact match and expiry
rather than manufacture runtime rows from this offline bundle.

Run the actual native-to-runner-to-Work-API failure consumer per provider using
that bundle's full native report. For example:

```bash
LCARS_NATIVE_FAILURE_REPORTS='["/tmp/policy-codex-candidate/native/image-observations.json"]' \
  pnpm exec vitest run --config tools/probes/failure-qualification.config.mts
```

One to three distinct providers are accepted. This consumer checks the captured
infrastructure-failure payload through the production route/outbox with memory
persistence and local GitHub transport. It must retain useful work, settle
failed, release the Codex lease where applicable, and perform no human-assignment
writes. It is still offline qualification.

## Approval targets and remaining acceptance

Keep #2181 open until the current candidate's normal dispatch and activation
gates have evidence. [#2044](https://github.com/jlapenna/agent-lcars/issues/2044)
is closed for its fresh native Claude interactive instruction-compliance scope;
it does not qualify a new worker image or policy-enabled dispatch.
Historical #2031/#2032 evidence establishes its named workstation/dispatch
checkpoint, not adoption of a newly built image.

For each provider, choose useful existing work through normal intake with
nonconflicting ownership. Obtain approval for a policy-enabled candidate
executor before launching it. Observe legitimate implementation/publication,
mode and ownership denial, primary-worktree denial, review holds, and bounded
same-session correction/recovery. Use isolated fixtures for forbidden operations
so no real unauthorized write is attempted. Record run/attempt/session,
Job/Pod/image identity, selected provider, exact-marker artifact and finalizer
result. Do not replace useful-work acceptance with a synthetic no-op issue.
Record member-repository and interactive non-dispatch behavior separately.

The concrete process command proposals below target the **Homelab-managed
QueueExecutor autoscaler container**, with its existing credentials, Kubernetes
namespace/node selectors and `/config/orchestrator.yml`. They are proposals for
the owner to incorporate into the canonical Homelab service definition and
restart pathway, not commands for a worker to execute or concurrent controllers
to launch. Keep the approved candidate worker image digest pinned via
`LCARS_QUEUE_RUNNER_IMAGE`. The autoscaler itself must also contain the selector
forwarding change.

| Provider under review | Proposed executor process command                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| Claude only           | `env LCARS_WORKER_POLICY_PROVIDERS=claude /usr/local/bin/runner-autoscaler --config /config/orchestrator.yml`   |
| Codex only            | `env LCARS_WORKER_POLICY_PROVIDERS=codex /usr/local/bin/runner-autoscaler --config /config/orchestrator.yml`    |
| OpenCode only         | `env LCARS_WORKER_POLICY_PROVIDERS=opencode /usr/local/bin/runner-autoscaler --config /config/orchestrator.yml` |
| Disable all           | `env LCARS_WORKER_POLICY_PROVIDERS= /usr/local/bin/runner-autoscaler --config /config/orchestrator.yml`         |

Approval must name the provider, source SHA, immutable worker and autoscaler
image digests, canonical Homelab service/host/namespace, time window and rollback
owner. This scoped dispatch cannot read the private Homelab deployment to verify
its live service identity; the owner must resolve that identity before approval.
The command targets above are repository-defined process targets, not a claim
that an unverified Compose/systemd/Kubernetes resource name exists. Publication
or `source-reconcile.yml` alone does not set the selector.

## Observation and rollback

Start with one approved provider and at most three useful dispatches, one at a
time, in a 30-minute window. The owner must reserve the window with no other
work for that provider on the candidate executor. The selector is provider-wide,
not an attempt allowlist or sampling mechanism. A broader live queue requires
an isolated owner-managed executor scope before activation. Leave other
providers disabled; successful providers need not await a failed provider. At the end of the window,
restore the previous selector before admitting more attempts. Do not accept the
window until every in-flight attempt settles under its original budget; a
configuration restart does not cancel an existing Job.

Retain a baseline and a per-attempt ledger with these counts and denominators.
Metrics are collected from receipts, sanitized native diagnostics, Job status
and exact-marker finalization; new production counters are not claimed.

| Metric            | Measurement                                                                                  | Acceptance / stop                                                          |
| ----------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| False rejection   | Authorized supported actions rejected / authorized supported actions attempted               | Zero; any confirmed false rejection stops the window                       |
| Valid delivery    | Useful exact-marker deliverables accepted / legitimate dispatches completed                  | All completed work must deliver or preserve a truthful execution diagnosis |
| Forbidden effects | Independently observed forbidden effects / forbidden fixture actions attempted               | Zero; any effect stops immediately                                         |
| Recovery          | Successful recovery receipts / allowances consumed; count control-failed receipts separately | At most one allowance per attempt; no failure concealed as PARK/success    |
| Budget            | Monotonic elapsed execution, initial/correction limits, lease/verifier admission             | Original budget cannot grow; no exhausted correction admitted              |
| Preservation      | Useful/unrelated files or refs lost or duplicated writes / fault cases                       | Zero                                                                       |
| Setup             | No-launch setup failures / selected attempts                                                 | Unexpected failures stop admission and preserve diagnostics                |

Stop on any forbidden effect, confirmed false rejection, failed identity binding,
unbounded round, lost work or concealed control failure. Do not rerun the same
failure into acceptance; diagnose once, apply a targeted correction, rebuild and
requalify changed artifact bytes.

Rollback restores the exact captured previous provider list (remove only the
failing provider if others were independently approved), or the explicit empty
command above if starting from off. Restore it in canonical Homelab deployment
state and use the approved restart pathway. Read back the restarted executor
and a newly created Job's `LCARS_WORKER_POLICY_PROVIDERS` and image identity.
Changing the executor affects future Jobs only. Existing attempts retain their
launch-time controls and preserved workspace; do not delete them or restart a
possibly completed external write. An in-flight unsafe attempt requires the
owner's normal cancellation/recovery procedure. Record rollback latency from
stop decision to verified new-Job configuration and any outstanding attempts.
