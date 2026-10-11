# Deployment source-order qualification, 2026-10-11

This read-only observation advances [#2292](https://github.com/jlapenna/agent-lcars/issues/2292).
The source correction already landed in [PR #2258](https://github.com/jlapenna/agent-lcars/pull/2258)
as `9b6065e4acca539acd352d403929a5de59cc2895`. No workflow, deployment,
credential, fleet setting or production data was changed for this observation.
This is dated evidence, not deployment policy; the current contract belongs to
[deployment-boundary.md](../../deployment-boundary.md).

## Source correction and independent review

The first deploy step, after acquiring the shared lock, rejects automatic
sources that differ from the current main tip. Every later step requires
`deploy_current == 'true'`. Ordinary manual sources bypass this lookup;
`recovered-ci` sources remain fenced. Lookup failures fail closed.

The original [review thread](https://github.com/jlapenna/agent-lcars/pull/2258#discussion_r4233353489)
is resolved. Its [correction reply](https://github.com/jlapenna/agent-lcars/pull/2258#discussion_r4235475112)
records independent review of exact head
`8f20a5d33c665f4478a815025cf332f871c45a11`, actual shell probes and
later-step checks. Owning tests in
`tools/contract-tests/deploy-console-source-fence.test.ts` execute the actual
workflow shell for delayed older gates and reverse CI completion. These are
regression and source proofs, not live delayed-gate experiments.

## Normal automatic delivery

Observed source: `a9324dd910e3ed7cccf3599c1e5bc85e51bba403`, containing the
source fence and subsequent pending-queue retention correction.

| Boundary                    | GitHub evidence                                                                                 | Observed result                                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main push CI                | [38102934745](https://github.com/jlapenna/agent-lcars/actions/runs/38102934745)                 | Success; actual `Full verification` ran successfully, including contracts, formatting, lint, test/typecheck/build and the Firestore emulator store check. `Verify` also passed.                                   |
| Automatic deployment        | [38103949410](https://github.com/jlapenna/agent-lcars/actions/runs/38103949410)                 | Event is `workflow_run`; the gate log names source CI `38102934745` and its successful Verify result.                                                                                                             |
| Admission timing            | [gate job](https://github.com/jlapenna/agent-lcars/actions/runs/38103949410/job/114365393321)   | Gate ran 02:04:29–02:04:35 UTC; source Verify lookup succeeded at 02:04:33.                                                                                                                                       |
| Source and rollout          | [deploy job](https://github.com/jlapenna/agent-lcars/actions/runs/38103949410/job/114365414591) | Deploy ran 02:08:29–02:14:47 UTC; source check passed and checkout printed `HEAD is now at a9324dd`. Managed rollout completed successfully.                                                                      |
| Exact archive/build linkage | Same deploy job                                                                                 | Uploaded `gs://firebaseapphosting-sources-611425338852-us-central1/agent-lcars--413-Aedqk1mOrRk2-.zip`; exact archive lookup resolved `build-2026-10-11-003`, also recorded in the successful PR annotation step. |
| Serving smoke               | Same deploy job                                                                                 | At 02:14:41 UTC, actual deploy verification logged `attempt 1/10: https://lcars.jlapenna.net -> 307` and succeeded.                                                                                               |

The roughly four minutes between gate completion and deploy start are an
observed wait, not an attribution to a particular runner or lock occupant.
The 307 response proves the existing non-500 serving smoke boundary. It does
not establish an authenticated browser journey, Cloud Run traffic attribution,
or that every application function is healthy.

## Actual stale-source rejection

[Automatic run 38103095693](https://github.com/jlapenna/agent-lcars/actions/runs/38103095693)
reports overall success, but its actual source step at 01:57:24 UTC says:

```text
Skipping superseded automatic source ba47d27f39b01b653dc24c4854054b1a0f262fcb; main is a9324dd910e3ed7cccf3599c1e5bc85e51bba403.
```

This is an actual stale automatic source being rejected before rollout,
followed by normal automatic delivery of the newer source above. It is not a
live reproduction of the exact older-delayed-gate-after-newer-rollout ordering.
An aggregate successful deployment run alone would obscure this distinction.

## Remaining acceptance boundaries

- This dispatch credential cannot inspect rule suites: the read-only
  `GET /repos/jlapenna/agent-lcars/rulesets/rule-suites` returned HTTP 403
  (`Resource not accessible by integration`). PR #2258's visible required
  checks pass, but that alone does not independently prove a `pass` rules-suite
  result for merge commit `9b6065e4acca539acd352d403929a5de59cc2895`.
- The independent pre-correction negative controls are recorded in the
  existing correction review; this observation does not claim to have rerun
  them or performed an independent live before/after scheduler experiment.
- [#2297](https://github.com/jlapenna/agent-lcars/issues/2297) retains the
  distinct occupied-lock queue/liveness qualification. The queue retention
  correction's documented bypass incident is not erased by subsequent main
  CI or serving success.
- Keep #2292 open until its owner reconciles the independent probe and
  protected-merge evidence with the original requirement boundary. No manual
  deployment, workflow dispatch, rerun or policy mutation is needed to obtain
  the already-existing automatic delivery evidence above.

## Focused verification in this dispatch

At unchanged production revision
`a9324dd910e3ed7cccf3599c1e5bc85e51bba403`, the normal linked author worktree
ran the three owning admission, source-fence and configuration test files via
`pnpm exec vitest run --config tools/contract-tests/vitest.config.mts` with
`--maxWorkers=1`: 3 files and 32 tests passed, exit 0. This replay confirms
the current contracts; it adds no live scheduler evidence.

## Reproduce the read-only observation

```bash
gh pr view 2258 -R jlapenna/agent-lcars --json headRefOid,mergeCommit,mergedAt
gh pr checks 2258 -R jlapenna/agent-lcars
gh run view 38102934745 -R jlapenna/agent-lcars --json jobs
gh run view 38103949410 -R jlapenna/agent-lcars --json event,headSha,jobs
gh run view 38103949410 -R jlapenna/agent-lcars --log
gh run view 38103095693 -R jlapenna/agent-lcars --log
```

Inspect actual executed step output, not the echoed shell source alone.
