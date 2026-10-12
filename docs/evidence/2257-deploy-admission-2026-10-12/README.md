# Deployment admission observation, 2026-10-12

This read-only observation advances [#2257](https://github.com/jlapenna/agent-lcars/issues/2257).
The implementation already landed in [PR #2258](https://github.com/jlapenna/agent-lcars/pull/2258)
as `9b6065e4acca539acd352d403929a5de59cc2895`. This dispatch changes only
this evidence record. No manual deployment, workflow dispatch, CI rerun,
permission change or production mutation was performed.

Current deployment policy belongs to [deployment-boundary.md](../../deployment-boundary.md).
This dated observation does not replace that contract.

## Existing implementation and review

Production concurrency belongs to the admitted `deploy` job, with group
`deploy-console` and `cancel-in-progress: false`. The workflow has no
workflow-level concurrency. Ineligible completion events skip the gate and
deploy jobs, so they do not enter production serialization.

The owner's [independent review receipt](https://github.com/jlapenna/agent-lcars/pull/2258#issuecomment-6086987945)
approved the concurrency move and hosted gate placement, including 19 contracts
and actionlint. The [merged PR checks](https://github.com/jlapenna/agent-lcars/pull/2258/checks)
include successful Verify, Full verification, E2E, runner seed and Terraform
checks. This dispatch did not repeat that independent review or local tests.

Owning admission coverage is in `tools/contract-tests/deploy-console-admission.test.ts`:
pending-main group isolation from PR/non-main/unsupported completion events,
failed Verify exclusion, and shared serialization for admitted main and manual
dispatch. Source-fence coverage separately exercises the actual workflow shell.
These tests evaluate declarations and predicates, not GitHub's scheduler.

## Normal main delivery survives unrelated PR completion

All times below are UTC on 2026-10-12, read from Actions metadata and executed
log output. Explicit source markers and checkout establish source identity;
the downstream run's metadata `head_sha` alone is insufficient.

| Boundary              | Evidence                                                                                                | Result                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main source           | [PR #2522](https://github.com/jlapenna/agent-lcars/pull/2522)                                           | Merged at 05:50:06 as `bd90821ff6664314e6cd12c501d8fcdc47fd1310`.                                                                                                         |
| Upstream CI           | [38209685164](https://github.com/jlapenna/agent-lcars/actions/runs/38209685164)                         | Successful push CI on main at that exact source.                                                                                                                          |
| Automatic admission   | [38211042075 gate](https://github.com/jlapenna/agent-lcars/actions/runs/38211042075/job/114685039134)   | Ran 06:07:47–06:07:50; executed lookup reported successful Verify for CI 38209685164 at 06:07:49.                                                                         |
| Production execution  | [38211042075 deploy](https://github.com/jlapenna/agent-lcars/actions/runs/38211042075/job/114685066005) | Ran 06:07:58–06:25:19 and succeeded; source check and checkout used `bd90821ff6664314e6cd12c501d8fcdc47fd1310`.                                                           |
| Unrelated PR CI       | [38208651678](https://github.com/jlapenna/agent-lcars/actions/runs/38208651678)                         | Successful `pull_request` CI on `test/trim-mirror-tests`, source `8302603792e2dfc04f9519cd18d7dd76677ac3e4`, completed at 06:09:33 while production execution was active. |
| Ineligible downstream | [38211183631](https://github.com/jlapenna/agent-lcars/actions/runs/38211183631)                         | Created at 06:09:35 with the PR source marker; both gate and deploy were skipped. The eligible production execution continued.                                            |
| Exact build           | [release annotation](https://github.com/jlapenna/agent-lcars/pull/2522#issuecomment-6118951812)         | The managed source archive lookup resolved `build-2026-10-12-003` and annotated the source PR.                                                                            |
| Serving smoke         | Same production deploy log                                                                              | At 06:25:14, `attempt 1/10: https://lcars.jlapenna.net -> 307`; the owning smoke action succeeded.                                                                        |

This proves a normal eligible deployment retained admission and completed
under an actual unrelated PR completion. The 307 proves the existing non-500
serving smoke boundary, not an authenticated browser journey or independent
Cloud Run traffic attribution.

## Remaining qualification

The observed deployment was already running when the PR completion arrived.
It does not reproduce an eligible deployment pending behind an occupied lock
at that instant. Declaration-level coverage protects that boundary, but this
record does not claim a live pending-slot experiment. Preserve that distinction
when reconciling the original zero-job cancellation and the separate queue
liveness work in [#2297](https://github.com/jlapenna/agent-lcars/issues/2297).

The read-only rules-suite endpoint returned HTTP 403, `Resource not accessible
by integration`, for this dispatch credential. Successful required PR checks
alone do not establish a protected merge `result: pass` for exact merge
`9b6065e4acca539acd352d403929a5de59cc2895`. Keep #2257 open until that
protected-merge evidence and the remaining pending-slot qualification are
reconciled by an authorized observer. Do not trigger a manual deploy to fill
these evidence gaps.

## Reproduce the observation

```bash
gh pr view 2258 -R jlapenna/agent-lcars --json mergeCommit,mergedAt,statusCheckRollup
gh run view 38209685164 -R jlapenna/agent-lcars --json event,headSha,jobs
gh run view 38211042075 -R jlapenna/agent-lcars --log
gh run view 38208651678 -R jlapenna/agent-lcars --json event,headSha,jobs
gh run view 38211183631 -R jlapenna/agent-lcars --json event,displayTitle,jobs
gh api repos/jlapenna/agent-lcars/rulesets/rule-suites
```

Inspect actual step output, rather than echoed shell source. A successful
aggregate run can also represent a superseded source being skipped; the
checkout, managed deployment, exact build resolution and smoke steps above
actually executed.
