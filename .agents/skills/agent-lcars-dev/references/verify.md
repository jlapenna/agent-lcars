# Verify — Definition of Done

The full gate — this is what `.github/workflows/ci.yml`'s `Verify` job
(a required check gating every merge) authoritatively runs on its own
configured runner (`agent-lcars-ci` for trusted work, GitHub-hosted for fork PRs):

```bash
pnpm check:dependencies    # lockfile / workspace-mandate integrity
pnpm format:check          # prettier, nx format:check --all
pnpm lint                  # nx run-many -t lint --all
pnpm lint:circular          # madge circular-dependency check
./tools/nx run-many -t test typecheck build test-race --all
```

The composite `pnpm verify` runs formatting, lint, circular-dependency checks,
tests, typecheck, and build. It does not include `check:dependencies`,
`test-race`, or the workflow's Terraform/tooling checks; do not call it the
complete CI gate. Consult `.github/workflows/ci.yml` for those additional
boundaries and use CI delegation below.

## CI delegation

For a failed or stalled publication, use
[delivery-recovery.md](delivery-recovery.md) to distinguish transport, hook and
ambiguous-response failures before retrying. A transport error does not waive
any verification gate below.

Don't run the full gate above locally before every push — see "Push early"
in [SKILL.md](../SKILL.md#hard-guardrails). The pre-push hook runs the fast
slice (`format:check`, affected `lint`/`typecheck`); the whole-tree `test`
and `build` targets — the two steps that scan/compile the whole affected set
and take the longest — are deliberately left out, because CI's `Verify` job
re-runs them anyway the moment you push, on its own runner rather than your
workstation. The gate still runs exactly once as far as the merge
requirement is concerned; running it a second time locally first only adds
a serialized wait in front of a check that was going to happen regardless.

That fast slice is the entire local gate **only when `apps/console` is not
affected.** The hook's last step is `tools/console-build-smoke.sh`, which
builds and probes the deployable Console bundle whenever `apps/console` is
in the affected set: the real production `@nx/next:build` through
`@agent-lcars/console:bundle`, then `tools/console-standalone-smoke.sh`
booting a copy of the standalone bundle from outside the repository, loading
every external its server chunks traced, and expecting HTTP 401 from the
webhook route. That is a deliberate, Console-scoped exception to the no
local build rule — not a local copy of CI's whole-tree `build` target, and
not a substitute for CI's required `Verify` or `E2E` checks. Describe the
hook as the affected lint/typecheck slice plus this Console build exception;
calling it "no local build" is wrong for a Console-affected push.

Plan the publication envelope for the hook path that actually runs. A
Console-affected publication includes a real `next build`, so qualify its
CPU, memory and time bounds for that build and give it the supported worker
control `LCARS_CONSOLE_BUILD_CPUS`
([apps/console/build-workers.cjs](../../../../apps/console/build-workers.cjs))
or a qualified cgroup CPU quota, so the page-data worker pool follows the
phase's own bound instead of the host's visible CPU count. Planning a
Console-affected publication as "no local build" omits work the normal hook
will start anyway.

Run the full local gate only when you have a specific reason not to trust
CI's answer for it — e.g. iterating on a change to the Nx config or task
graph itself, where you want to see the affected-project computation
directly. Otherwise: fast layer locally, push, let CI's `Verify` job carry
the rest.

## Bounded local verification

Size each local phase for one eligible runner after host/service reserves and
record the selected CPU, memory, storage, accelerator and time bounds before
starting it.
Use supported supervisors and accounting capabilities; repository verification
does not authorize changing host delegation or understating requests to fit a run.

Size the publication phase for the hook path the push actually executes, not a
shorter one you assumed. `.husky/pre-push` adds the affected-Console production
build and standalone smoke (`tools/console-build-smoke.sh`,
`tools/console-standalone-smoke.sh`) to every `apps/console`-affected
publication, so that build's CPU, memory and time belong in the envelope; use
its supported worker control `LCARS_CONSOLE_BUILD_CPUS` rather than a smaller
plan that omits the build. "No local build" is a correct plan only when
`apps/console` is unaffected.

Recorded case: source `bfbd72e8` passed 23 normal lint/typecheck tasks inside a
publication plan that omitted the affected Console build; the normal hook then
entered that real production build and the supervisor stopped only its own unit
`lcars-root-2200-provider-clock-publish-01a11f2d` after 164.612 s wall with
162.557 CPU seconds and 1.4 GiB peak / no swap, main terminating on SIGTERM 15.
Systemd's requested-stop result `success` was not publication success and the
exact remote branch was absent; no OOM kill and no failed application assertion
was observed. The same change later published through the complete hook — one
supported build worker, the real production build and the isolated
seven-externals and HTTP 401 smoke — passing in 138.254 s wall with 133.640 CPU
seconds and 1.9 GiB peak / no swap. Keep the two receipts distinct: the first
is an interrupted partial phase, the second the successful complete-hook
publication ([#2550](https://github.com/jlapenna/agent-lcars/issues/2550)). No
document-literal test mirrors this guidance; the hook and the two smoke scripts
stay the executable owners.

Before each local phase, record fresh, read-only host and cluster occupancy for
that selected host: supported capacity and reserves, systemd/cgroup, container
and cluster workloads, their owners and full resource envelopes, and available
storage. Include queued or physically retained work that could start there
during the phase. First qualify Pending work for the selected host using its
actual node selectors, required affinity, and relevant node taints and workload
tolerations. Preferred affinity is a preference, not a required placement
constraint. Check scheduler-feasible request combinations for CPU, memory and
storage together on that host before assessing full declared limits/envelopes
for credible overlap with the local phase and reserves. Save changed raw node
and workload rows before issuing the capacity verdict. Kubernetes allocatable
and Pod inventory alone do not prove complete host safety.
Reconcile declared reserve coverage and count nested
unit/container/Pod/cgroup workloads once. If placement, ownership, required
accounting visibility, reserve coverage or overlap fit is unknown, hold the phase. Verify
the full proposed envelope fits together on that one supported host under the
credible overlap. Temporary contention changes when work can start, not its
supported size; wait or split/resize actual work while retaining required
reserves and truthful requests. Never understate demand, rely on overcommit,
change host controls or stop another owner's workload to make the phase fit.

Classify reclaimable memory separately from immutable resident demand. A
`memory.current - inactive_file` working set still includes kernel caches:
record `slab_reclaimable` and `slab_unreclaimable` for each independently owned
cgroup. These counters identify cache that might be reclaimed, not guaranteed
available memory. Do not subtract the full counter to manufacture admission
headroom, or exclude total kernel memory, anonymous memory, shared memory or
active file memory. Keep the full declared host/service reserve and count its
covered workloads once. Admission must pass both full-envelope/reserve accounting
and a fresh host `MemAvailable` bound for additional unallocated phase/native/peer
memory demand and remaining reserve headroom. Do not add reclaimable-slab counters
to `MemAvailable`: its estimate already discounts slab still in use. Refuse if
that additional demand or available headroom cannot be qualified; do not lower
reserves, purge caches or understate a phase. Re-read counters and availability
with the complete native/peer overlap immediately before launching.
The [kernel memory interface](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files)
defines the counters; the [host availability estimate](https://docs.kernel.org/filesystems/proc.html#meminfo)
accounts for in-use slab. [#2763](https://github.com/jlapenna/agent-lcars/issues/2763)
records a refused phase caused by treating reclaimable slab as an extra reserve.

### Requalify colocated worker turnover

Ordinary replacement of a colocated ARC Pod or process requires fresh
qualification, not a new authorization for an unchanged planned phase. Save
the changed raw inventory rows and recheck placement, ownership classification,
scheduler-feasible request combinations, full-envelope overlap with reserves,
and storage and accelerator/device fit before starting. When every check passes
and the authorized phase's bindings remain unchanged, continue under its
existing authorization; a changed Pod UID or process identity alone does not
revoke it. Earlier receipts cannot qualify the replacement.

This rule covers colocated runners, not replacement of the issue's own author
or native worker. Hold for an author/native-worker replacement or task ownership
collision until ownership and the phase's bindings are reconciled. Also hold
for changed reviewed source, issue/PR body, base, setup or required hooks;
unknown ownership or placement; unclassified independent jobs; unsafe
full-envelope overlap or device fit; or unavailable/insufficient required
storage guards. Requalifying turnover cannot authorize source substitution,
hidden jobs, unsupported resource requests, or counting a reserve and its
covered nested workload twice.

The positive case recorded in [#2429](https://github.com/jlapenna/agent-lcars/issues/2429)
was same-envelope default Pod replacement: fresh qualification retained four
default workers at 6 CPU / 7 GiB, one E2E worker at 6 CPU / 12 GiB and one LCARS
default worker at 4 CPU / 6 GiB. Of 63 worker subsets, six were
scheduler-feasible and none had unsafe full-envelope overlap; the phase's
source, author worktree, native ownership and hooks were unchanged. That
turnover permitted continuation after qualification. In contrast, the
default + ci-light combination recorded in
[Homelab #1770](https://github.com/jlapenna/homelab/issues/1770) exceeded supported
CPU capacity at full envelope before adding any local job. Request-feasible
placement cannot make that overlap safe: hold the local phase. These are
recorded cases, not reusable capacity receipts for a future launch.

Ordinary fast checks retain the commands in [CI delegation](#ci-delegation);
this repository does not ship a general resource-accounting supervisor.
For a phase explicitly requiring resource guards, identify an available
supported executable facility and its required accounting method first.
On supported systemd hosts, [systemd-run](https://github.com/systemd/systemd/blob/main/man/systemd-run.xml)
can supervise CPU, memory and time through supported unit properties; consult
[resource controls](https://github.com/systemd/systemd/blob/main/man/systemd.resource-control.xml)
and verify the actual host's capabilities and selected properties. This facility
does not provide an owned disk quota or a filesystem-monitor readiness handshake.
An unavailable required guard is a setup gate, not a reason to invent a wrapper
or bypass verification.

A resource monitor declared as a required guard for that phase must prove
readiness before the supervisor starts its workload: validate the accounting
paths/counters and record a successful baseline and first sample. Do not assume
`io.stat` exists in a user cgroup. Identify and validate the supported required
measurement before execution, or stop with a setup failure. Record the method,
filesystem identities, observed paths, baseline, sample interval and stop limit;
include owned outputs, temporary files and caches in the declared scope.

Before claiming cache or store isolation, query the actual paths with the
pinned package manager in the worktree's command environment. An exported
setting alone does not prove selection. Include the resulting paths in
filesystem accounting; ordinary author setup may use the supported shared
store. If a review requires an owned store, use supported explicit
configuration and verify selection before installation. Record setup and
observer exits separately: a postsetup assertion does not erase successful
installation or justify reinstalling an unchanged worktree.

Propagate startup and later measurement failures to the supervisor. A required
monitor exiting unexpectedly, including exit 0, fails the phase and stops only
its owned workload/process group. Capture actual child exits and termination;
check cleanup separately from workload success. A background task without a
readiness handshake, or `wait ... || true` suppressing a required monitor's
failure, cannot establish guarded execution. Validate this boundary with bounded
subprocess fixtures: failed readiness must start no workload, and a later
failure must terminate the owned child while an unrelated witness stays alive.
Use the actual supervisor, with isolated accounting probes and inert children;
do not replace it with a test implementation or add tests that mirror this text.

Shared filesystem free-byte samples measure net filesystem activity.
Concurrent releases can mask an owned workload's allocation, so these samples
cannot alone enforce or prove its storage ceiling. If a phase requires that
ceiling, use supported attributable allocation accounting or an actual quota;
hold the phase if the required bound cannot be qualified. Keep shared free-space
samples as diagnostics. Record sampled maxima, final footprint and before/after
free-byte observations under those names. Sampling does not prove an unsampled
peak or enforce a hard disk quota; cumulative IO bytes differ from allocated
disk growth.
If a required guard failed, preserve that failure and distinguish any valid
source/test/commit evidence from unproven resource enforcement. Do not rerun a
completed operation to erase its original receipt.

### Qualify the supervised child environment

Login-shell availability does not qualify a supervised phase. A phase whose
tools were proven by `command -v` in the launching shell still starts its unit
in the manager's environment, not that shell's. Recorded case: unit
`lcars-root-phone-2201-publication-01a11f2d` (invocation
`bfd6e91e20e946009e4645129bdce868`) exited 127 after 207 ms wall and 29 ms CPU
with `pnpm: command not found` at
[`tools/setup-worktree.sh`](../../../../tools/setup-worktree.sh) line 22, having
completed no dependency, test, commit or push phase; the login shell resolved
`node` and `pnpm` from version-manager multishell bins a default user unit never
inherits ([#2525](https://github.com/jlapenna/agent-lcars/issues/2525)). Qualify
the executable environment the supervisor actually hands the child, then prove
it from inside that child.

Pass the already-qualified stable Node installation's own `bin` directory ahead
of ordinary `PATH` through the supervisor's explicit environment control —
`--setenv=PATH=<qualified-bin>:<rest>` (or `-E`) for `systemd-run`, or
`Environment=PATH=` in a declared unit — as a literal value, and keep the
qualified directory ahead of the inherited remainder. Do not rely on the
launching shell's lookup, on a transient service inheriting that shell's
environment (it does not), or on `$PATH` expansion inside an environment assignment: `Environment=`
and `--setenv` preserve a literal `$PATH`. If the caller uses a double-quoted
shell argument, that shell expands `$PATH` before invoking `systemd-run`;
this is separate from systemd's command-line expansion in `ExecStart=`.
Construct and qualify the complete PATH value explicitly. See systemd's
[Environment= semantics](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml). Keep
source, tool identity, hooks, isolation and cache behavior unchanged: do not
install a second toolchain, re-resolve a version-manager shim, or weaken
isolation to make a lookup succeed.

Set the supervisor's working directory to the qualified source checkout
(`systemd-run --working-directory=<checkout>` or `WorkingDirectory=`).
Corepack may select a different pnpm version from the manager's default
directory even when PATH resolves the same shim. Qualify the directory and
project-pinned package-manager identity together.

Have the unit report the `node` and `pnpm` paths and versions it actually
resolved before any setup or dependent work, and record that report with the
actual numeric child exit. An absent required toolchain must fail in that
in-child preflight so no setup, install, test, commit or push phase starts, and
the phase keeps the true nonzero exit and resource receipt. The supervisor's
default status after unit collection is not workload success. Prove this at the
real supervisor/environment boundary: under the supported supervisor, a child
environment without Node, or with Node available but pnpm absent, starts no
setup witness. A qualified one starts the harmless witness and reports both
resolved paths and exact versions. Guidance
text, a login-shell lookup, or a fixture that only re-reads this section proves
the document, never the boundary.
[`tools/contract-tests/supervised-child-env-qualification.test.ts`](../../../../tools/contract-tests/supervised-child-env-qualification.test.ts)
covers those cases through a real transient user unit where a manager is
reachable, and through a child environment with no inherited PATH everywhere
else.

### Qualify native-binding cache ancestors

For a phase that loads SWC, an owned cache leaf alone does not qualify its
placement. Inspect the nested native-loader error: `ERR_SWC_NATIVE_CACHE` can
reject a group-writable ancestor even when the installed native package and
binary are present. Check the selected directory's ownership, permissions and
ancestor trust before claiming a missing dependency or reinstalling.

If the selected cache fails that trust check, use the supported
`SWC_NATIVE_BINDING_CACHE` override with a phase-specific, user-owned mode `0700`
directory directly beneath a verified trusted sticky directory (such as
root-owned mode `01777` `/tmp`), with the remaining ancestors trusted. Pass its absolute path through the
supervisor's explicit child environment, as with PATH above. The selected cache filesystem must be writable and executable; Linux `noexec`
is rejected. Choose another ancestor-trusted executable location if needed. See
[SWC's native-addon cache contract](https://github.com/swc-project/swc/blob/main/docs/native-addon-carriers.md#first-load-and-cache).
Include this cache
in the phase's storage sizing/accounting. Preserve the existing `HOME`, worktree,
Nx cache receipt/helper, other native-cache guards and normal hooks; do not
change shared directory permissions, reset caches or disable a plugin to make
the loader succeed.

Before loading SWC, qualify and budget potential native-output locations for
its selected mode: cache/default/fallback roots, and the installed carrier's
parent plus process-temporary roots when replacement is eligible. Preserve the
SDK's ancestor trust, integrity, writable/executable filesystem and cleanup checks.
Persistent modes on writable btrfs may stage beside and atomically replace the
carrier, then load a verified temporary image from the default user cache or its
fallback, independently of the custom override. See
[SWC's replacement contract](https://github.com/swc-project/swc/blob/main/crates/swc_native_addon/README.md#transparent-filesystem-compression).

From the normally installed worktree and qualified child environment, observe
the actual native image in that same Node process (on Linux, `/proc/self/maps`)
and correlate it with the trusted carrier and SDK's verified materialization.
For cache materialization, verify the actual selected root; an absolute override
can fall back. Unix unlinks temporary images after loading, so a mapped
`(deleted)` path can be expected. A preexisting file or version output alone does
not prove placement. Account for all carrier, staging, cache and temporary
outputs across their filesystems, rather than silently charging only the override.

An out-of-override image alone is not failure. Unknown/unobservable materialization,
unqualified locations or fallback, integrity/security errors, or insufficient
required accounting fail readiness. Retain only selected mode/path evidence,
not a full process report or environment. Choose qualified locations without
changing host controls or bypassing SDK checks. Readiness does not replace normal
affected lint/typechecks, selected Console build/smoke or publication.

Recorded [#2662](https://github.com/jlapenna/agent-lcars/issues/2662): SWC
`1.16.18` rejected the verifier's XDG/TMP locations beneath a mode `0775`
ancestor. A private `0700` cache beneath trusted sticky `/tmp` loaded the same
installed module and completed the unchanged-source normal push, including the
one-worker production Console build, seven traced external packages and HTTP
401 smoke. Preserve the original failed hook receipt separately; neither a
missing payload nor a need to reinstall was established.

### Qualify the workload shape a CPU bound covers

A CPU bound qualified for one workload shape does not qualify a different one.
Every supervised phase has a finite wall-clock bound, including formatting,
lint, typecheck and static-hook checks. Qualify the actual workload and its
deadlines under the selected envelope. Deadline-sensitive DOM waits, lazy
imports and component transitions also depend on event-loop progress within
their assertion timeouts; throttling is one possible source of delay. A
sub-core ceiling is neither automatically adequate for static work nor
categorically inadequate for DOM work: its measured result qualifies only
the workload and conditions tested. Recorded case: phase
`lcars-root-priority-2189-verify-publish-01a11f2d` (invocation
`2fdcca9e911542e59cb64db2ee98fe41`) was supervised at `CPUQuota=10%` (100m),
exited 1 after 325.509 s wall with 32.156 CPU seconds and 630.1 MiB/no swap,
and reported 78 orchestrator, 36 Work and 175 Console cases passing, 45
connected-Firestore cases skipped, and 3 failures in
[`apps/console/src/app/quick-task-button.test.tsx`](../../../../apps/console/src/app/quick-task-button.test.tsx):
two saw the lazily loaded trigger still `aria-busy` with no dialog at the wait
deadline and one retained the closed modal inside its 200 ms exit transition.
Source, assertions and timeouts were unchanged
([#2529](https://github.com/jlapenna/agent-lcars/issues/2529)).

Classify each selected local phase by shape before recording its CPU bound, and
qualify deadline-sensitive DOM diagnostics as their own shape:

- A phase inherits the most demanding shape it contains, not the least. Either
  size and run the DOM diagnostics in an envelope measured for that shape, or
  do not run those specs locally at all and delegate the owning UI behavior to
  the unchanged required `Verify`/`E2E` checks, which execute the same files on
  the supported CI pool. Do not resize the selected CI pool, fleet or host
  controls, and do not add a local lane, to make a delegated result exist.
- Qualifying a shape by measurement means a supported run of that same workload
  under the candidate bound. The absence of any other failure mode, a low
  absolute CPU count, or a shape that passed a static phase is not evidence the
  bound covers real-time waits.
- Keep timing/resource evidence separate from a demonstrated source defect. A
  deadline-sensitive wait that expires under a bound never qualified for its
  shape is unattributed: preserve the numeric exit, the resource receipt and the
  zero-commit/zero-push state that followed, and do not rerun the same
  unqualified envelope to turn it green, raise a timeout, disable a transition,
  mock away lazy loading or relax an assertion.
- Record the actual exact-head supported-runner result for the same source and
  assertions where the failure was: run/job identifiers, executed file, case
  count, duration and limits of the evidence. Passing under a different runner
  or envelope qualifies that context and narrows hypotheses; it does not isolate
  CPU throttling as the cause of the earlier failure. Causal attribution needs
  a controlled comparison or direct evidence that distinguishes competing
  causes. A separate failure remains under its own anchor.

The same-source UI checks passed on supported-runner CI run `38218317094` (Full
verification job `114708282485`), which executed that file at the priority head
with source, assertions and timeouts unchanged: 8/8 cases passed in 6999 ms and
the required browser lane passed. The same full run separately failed the
connected-Firestore fixture tracked under
[#2536](https://github.com/jlapenna/agent-lcars/issues/2536), so it is exact-file
evidence for those UI waits, not an overall green claim; the 100m receipt above
stays as recorded and was not rerun. This supported-context pass does not
isolate the cause of the earlier 100m failure.

### Return the admission verdict a launch gates on

A composed verification command's aggregate exit status is not an admission
verdict: whichever command runs last carries it. Recorded case: one shell ran
the envelope assertion and then a read-only occupancy probe. The assertion
refused the actual envelope — planned 2 CPU / 2 Gi over 9.1 CPU / 22656 Mi of
native demand against 23833168 Ki of post-reserve memory, after a new 2 Gi
control worker arrived — and exited nonzero, while the trailing probe exited 0
and became the shell's result. The caller read that aggregate zero as approval
and launched its own normal publication and setup phase from an earlier accepted
snapshot: unit `lcars-root-inbox-publication-01a11f2d` (invocation
`4233bb705590459fb47d5d9c7aa5e51d`) ran 19.103 s wall with 18.591 CPU seconds
and 371.6 MiB/no swap before SIGTERM during dependency setup, and systemd
reported the requested stop as successful
([#2511](https://github.com/jlapenna/agent-lcars/issues/2511)).

Capture the admission's numeric result before anything else runs, and return
that captured value as the composition's own explicit exit. Emit it in
machine-readable form as well (`admission-exit=<n>`), then have the consumer
start its owned workload only on the affirmative current result it received in
that same run: a returned refusal propagates unchanged, and an aggregate status
that returned no result at all is held under its own explicit nonzero exit —
never treated as success and never collapsed into the workload's code. A
read-only observation (probe, sample, status or capacity report) is never
approval; it may run after the admission, but it cannot overwrite or stand in
for the verdict. Ordering alone is not the contract either: a refusal that
reaches the aggregate only because it happened to run last still authorizes
nothing until the consumer receives it.

A prior accepted receipt qualifies the rows it measured, not this launch. When
current rows refuse, the current launch is refused even with an accepted receipt
on disk: do not consult it to recover approval, rewrite it, or rerun the
completed operation to erase it. Keep hooks, native workers, isolation and
resource accounting exactly as qualified, and keep the contract in the owning
composition and its own consumer — do not add a generic wrapper, a shared helper
lane, or a policy-literal test that only re-reads this section.
[`tools/contract-tests/refused-admission-fails-closed.test.ts`](../../../../tools/contract-tests/refused-admission-fails-closed.test.ts)
drives the real composition and its consumer over the recorded rows for an
accepted envelope, a refusal masked by a trailing read-only probe, a propagated
refusal, probe-first ordering, and a refusal against an earlier accepted
receipt, asserting the numeric exit, the gate report, whether the owned setup
witness exists, the read-only observation, and that the rows and receipt are
unchanged.

## Frozen Console test reviews

Use a separate, normally installed Git worktree at the exact reviewed commit
for immutable Console test evidence. A relocated `git archive` with
`node_modules` symlinked to another checkout is not an equivalent harness:
shared setup can resolve outside the archive root and fail collection with a
literal Vite `/@fs/` module identifier even when the underlying file exists.
That failure executes zero tests; it is not evidence of a missing dependency
or a failing HTTP contract. Do not repair it by disabling setup, copying shared
helpers or inventing another Vitest configuration.

1. Record the full reviewed SHA and check live ownership. Follow the
   [worktree guardrails](../SKILL.md#hard-guardrails) to create an exclusively
   owned review worktree and unique local branch at that SHA. Keep application
   changes in their separate feature worktree; do not switch or reinstall
   another owner's checkout.
2. Install the reviewed revision's frozen lockfile without running its
   lifecycle scripts:

   ```bash
   pnpm install --frozen-lockfile --ignore-scripts
   bash tools/setup-nx-native-file-cache.sh
   ```

   If using `env -i`, preserve the existing user `HOME` or pass an explicit
   owned `XDG_CACHE_HOME` on the budgeted filesystem to cache setup and the
   selected commands. Use the supported
   [cache setup](../../../../tools/setup-nx-native-file-cache.sh) and
   [cache helper](../../../../tools/nx-native-file-cache.sh); these own cache
   selection, validation and the install receipt. Do not repurpose `HOME`,
   copy their logic, disable setup guards or set `CI` merely to bypass cache
   readiness. Confirm setup actually exits 0 and the selected cache artifacts
   are available before running tests. If setup fails, stop and retain its
   true exit/log as zero executed tests; a completed install does not prove
   the isolated environment is ready. Keep the corrected environment's receipt
   separate, and reuse an already successful frozen install when unchanged.

   Do not run `setup-worktree.sh`, `setup-git-hooks.sh` or the workspace
   `prepare` script from the frozen review. Git stores the Husky bootstrap
   and hook path in the shared common directory; an older reviewed installer
   can replace that policy for every active sibling worktree. Record the
   configured hook path and shared bootstrap hashes before and after the
   install and require them to remain unchanged. Existing commit/push hooks
   stay enabled; author feature worktrees still use normal worktree setup.
   Retain the normal project config and shared test setup. If an ignored
   dependency build script is required by the selected tests, treat that as
   an explicit setup gate rather than running the reviewed workspace lifecycle
   or changing shared hooks.

3. Bind evidence to source before and after testing: require `git rev-parse
HEAD` to equal the reviewed SHA and `git diff --exit-code <reviewed-sha> --
.` to pass. Inspect untracked files; record hashes and the explicit scope
   of any independent test overlays separately from unchanged production,
   owning tests, setup, configuration and lockfile bytes.
4. Run the selected owning tests directly, without an Nx result-cache replay.
   From the review worktree root, for example:

   ```bash
   pnpm exec vitest run --config apps/console/vitest.config.mts \
     src/lib/runs-router.test.ts --maxWorkers=1 --no-passWithNoTests
   ```

   Select the actual file needed for the review. Retain the command, cwd,
   true exit status, complete log and executed test count. Preserve earlier
   zero-test collection failures separately from a successful rerun; do not
   replace their receipt with the new result.

5. When proving a regression boundary, apply a bounded negative mutation only
   in an owned isolated fixture, retain its diff and assertion failure, then
   restore and recheck the frozen source. A setup/collection failure is not a
   successful negative control. A run in an existing owning checkout can be
   additional evidence only when its source is byte-bound to the reviewed
   revision and using it respects that checkout's live ownership.

This procedure establishes scoped test evidence, not browser acceptance,
ready-event CI, protected delivery or deployed functionality. Keep deeper
tooling attribution uncertain until traced; a successful supported worktree
does not identify an upstream Vite defect.

## Console e2e

`pnpm verify` does **not** run the console E2E suite locally. CI has the
required E2E check: it selects affected console and harness changes and runs
the hermetic suite. Local E2E is optional diagnostic evidence for reproducing
or iterating on a browser failure; it is not required before pushing or part
of deliverable proof.

When a local reproduction is useful, use the same hermetic entrypoint as CI:

```bash
./tools/nx run @agent-lcars/console-e2e:e2e-local
```

### RSC client/server boundary traps

`apps/console` is a Next.js App Router app: scoped vitest + typecheck are
structurally blind to bugs at the server/client component boundary. Four
distinct traps shipped past both in one night (retro #521) and were only
caught by the hermetic e2e suite or CI's prerender step, each with a
multi-minute feedback loop:

1. **Component-as-prop across the boundary.** Passing a component
   reference as a prop from a server component into a client component's
   polymorphic prop (e.g. Mantine's `component={SomeComponent}`) fails at
   render with "Functions cannot be passed directly to Client Components."
2. **A `'use client'` module value-importing a server-deps module.**
   Drags Node-only dependencies (firebase-admin, google-auth-library, ...)
   into the browser bundle and fails the build with dozens of Turbopack
   resolve errors (the #59 failure mode). `import type` is always safe.
   Reusable Console modules that touch secrets, data stores, or Node-only
   dependencies start with `import 'server-only';`. That framework-native
   marker is the authoritative transitive build guard. The
   `fleet/no-server-only-imports-in-client` rule from
   `@jlapenna/repo-tools/eslint` derives its package and local-module coverage
   from Nx `platform:server` tags plus the actual
   `server-only`/`assertNotBrowser()` markers, and catches direct imports in
   the editor without a second hand-maintained denylist.
3. **Server code calling a function exported from a client module.**
   Fails at runtime with "Attempted to call X() from the server."
4. **Cross-page `next/link` transitions retaining hidden controls** (#503).
   Next.js Cache Components preserves prior routes in hidden Activity trees;
   that is expected behavior, not two visible pages. DOM/label queries can
   match cached controls and fail strictness (#2239). Assert the destination
   URL and resolved UI, and use exact accessible-role queries or explicit
   visibility filtering. A real browser observes this boundary; unit and
   type checks do not. See [Next's testing guidance](https://nextjs.org/docs/app/guides/preserving-ui-state#testing).

None of these are reliably caught by unit tests or typecheck (#537). Treat
any change that adds/removes a `'use client'` directive, moves a component
across the server/client line, or touches `apps/console/src/app`'s
navigation/layout as boundary-adjacent. CI will run the browser gate for that
change; run `console-e2e:e2e-local` (above) locally only when debugging or
reproducing a boundary failure.

Use `'use server'` only for exported Server Functions/Actions; it is not a
general replacement for `server-only`. Vitest aliases `server-only` to a
shared no-op fixture so plain Node/Vite unit tests can import server modules;
the production Next build does not use that alias and still fails if a marked
module enters the client graph.

An `apps/console`-affected push also gets a production `next build` smoke in
the pre-push hook: `tools/console-build-smoke.sh` runs the real
`@agent-lcars/console:bundle` build, then `tools/console-standalone-smoke.sh`
boots an isolated copy of the standalone bundle, loads every external its
server chunks traced, and probes the webhook route for HTTP 401. It catches
class 1 and prerenderable cases of class 3 before you push, and the isolated
boot additionally catches a dependency the build traced but did not execute.
Budget it as the real build it is — see [CI delegation](#ci-delegation) for
the affected-hook path and the `LCARS_CONSOLE_BUILD_CPUS` worker control. It
is not a substitute for CI's E2E gate: a build can't see anything that only
breaks at request time on a non-prerendered route or in a real browser
(class 4 stays browser-e2e-only). Local E2E remains
available for focused diagnosis, but is not required to deliver the change.

Use that target, not `:e2e` directly. It sets up the same environment CI's
"Prepare E2E environment" step does (materializing `.env.e2e` from
`tools/e2e/ci.env` without clobbering a customized one, and exporting the
`NEXT_PUBLIC_*`/`AUTH_SECRET` values that must exist _before_ the
`dependsOn` build inlines them). Run bare, `:e2e` fails on a fresh checkout
with a "not defined" error for whichever required env var the server reads
first, which names neither cause.

It also passes `--skip-nx-cache`, deliberately: an e2e result replayed from
the Nx cache reports a green suite that never ran, which is worse than
useless when the suite is the thing you are trying to trust. Use
`:e2e-docker` when reproducing a browser/runtime-specific CI failure in the
pinned runner environment. Screenshots are retained as failure diagnostics;
they are not committed pixel-equality gates. The repository-wide contract and
failure-triage checklist live in
[`docs/e2e-reliability.md`](../../../../docs/e2e-reliability.md).

To scope a run, drive Playwright directly — `:e2e` sets
`forwardAllArgs: false`, so trailing args passed to it are silently dropped
and the whole suite runs anyway:

```bash
./tools/nx run @agent-lcars/console-e2e:e2e-run --grep @smoke
```
