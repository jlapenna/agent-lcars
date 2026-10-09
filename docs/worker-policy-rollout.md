# Worker policy qualification and bounded rollout

This is the review artifact for [#2181](https://github.com/jlapenna/agent-lcars/issues/2181).
It authorizes no publication, deployment or production selector change. Homelab
owns those operations; Agent LCARS owns the executable controls and their
[coverage limits](worker-behavior-enforcement.md#initial-policy-coverage-not-enabled).
A provider passes independently. Offline success never means graduation.

## Candidate qualification

Before claiming bounded provider execution or starting an approval window, land
the monotonic budget/fence prerequisite
[#2223](https://github.com/jlapenna/agent-lcars/issues/2223), including deterministic
forward/backward wall-clock cases and all provider correction branches. Keep
[#2217](https://github.com/jlapenna/agent-lcars/issues/2217)'s diagnostic work and
[Homelab #2186](https://github.com/jlapenna/homelab/issues/2186)'s clock investigation
separate. A successful unchanged deadline test does not settle either cause. Offline
canaries can retain independent evidence before this prerequisite passes;
they cannot establish the production execution bound or authorize activation.

Agree on the reviewed source revision with the platform owner before any image
publish. Follow [canonical image publishing](image-publish-routing.md). Record
the candidate's immutable registry digest, local inspected image ID, build
source SHA and baked CLI versions; retain publisher provenance and scan results.
Do not promote a mutable fleet tag as a qualification shortcut.

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
retains the fresh native Claude interactive instruction-compliance gate.
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
