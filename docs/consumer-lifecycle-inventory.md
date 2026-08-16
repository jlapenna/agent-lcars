# Consumer recovery workflow inventory

> [!NOTE]
> **Point-in-time inventory (2026-08-09), not a current contract.**
> `libs/dispatch-contracts/src/recovery-observation.ts` and the hosted
> ingestion endpoint this document's "What this lands" section describes as
> future follow-up work were both removed in #1015 Wave 4 — the endpoint
> never gained consumer-repo OIDC trust (see #870) and this repo's own
> primary admission/completion/reconciliation path moved to
> [`libs/orchestrator`](../libs/orchestrator) instead (see
> [`docs/lifecycle-systems.md`](lifecycle-systems.md)). This document's own
> inventory of the eleven consumer workflows remains accurate as a
> historical snapshot; treat any reference to a
> `RecoveryObservation`/`recovery/v1:...` contract landing "in this same
> change" as describing work that was later un-landed, not current state.
>
> **What's still live in the consumer repos, unchanged by #1015.** Group A
> (`jlapenna/homelab`'s `agent-router.yml` + `dispatch-reconcile.yml`) is
> still the forked, pre-cutover copy of this repo's dispatch broker
> described below — it does not talk to `libs/orchestrator` and did not
> retire when this repo's own decision loop did; that loop retires only if
> and when that lane's dispatch is migrated onto the central orchestrator,
> which is a real design decision that has not been made or scheduled.
> **Group C no longer applies as described below**: both `homelab` and
> `sprinkles` have since migrated their `rerun-infra-killed-runs.yml` crons
> onto the central orchestrator's own lease sweep and bounded auto-retry
> (sprinkles#4453, homelab#660), so agent-lcars#1201 deleted the
> now-consumerless `.github/actions/rerun-infra-killed-runs` action and its
> `apps/rerun-infra-killed-runs` source project outright. Treat the Group C
> description and table omission-note below as describing the arrangement
> as it stood on 2026-08-09, not current state.

[#864](https://github.com/jlapenna/agent-lcars/issues/864) proposes making the
hosted controller (see [`lifecycle-systems.md`](lifecycle-systems.md)) the
sole decision-maker for lifecycle recovery in consumer repositories, and its
migration plan opens with: "Inventory each consumer workflow trigger,
decision, side effect, retry policy, and idempotency mechanism. Map every
decision to its owning system from #645." This document is that inventory,
read only — it does not change, dispatch, or reconcile anything in the repos
it inventories.

**Scope and method.** The eleven workflows #864 names, fetched read-only from
`supersprinklesracing/sprinkles` and `jlapenna/homelab` on 2026-08-09:
1,305 + 285 = **1,590 lines**, matching #864's own count exactly. Nothing in
either repository was modified to produce this document.

## Two different problems, not one

Reading all eleven files end to end, they split into three groups that need
three different treatments — collapsing them into one undifferentiated
"consumer recovery workflow" bucket, as #864 does today, understates how much
of this is already solved and overstates how much is one new capability.

**Group A — a forked, pre-cutover copy of this repo's own dispatch broker.**
`jlapenna/homelab`'s `agent-router.yml` and `dispatch-reconcile.yml` both call
a local `./.github/actions/dispatch-broker` composite with `operation:
normalize|broker|reconcile|claimant-preflight` — the exact interface
`agent-lcars`'s own `.github/actions/dispatch-broker` exposed _before_ the
hosted-controller cutover ([#736](https://github.com/jlapenna/agent-lcars/issues/736),
[#645](https://github.com/jlapenna/agent-lcars/issues/645) Phase 6). This is
not a new domain #645's vocabulary needs extending to cover — it is the
`controller` system's `signal`/`authorization`/`intent`/`scheduling`/`launch`/
`reconciliation` phases (`libs/dispatch-contracts/src/failure.ts`), already
fully specified, running a second, independently-drifting implementation in
another repository. The same lossy-concurrency-group queue problem
[#703](https://github.com/jlapenna/agent-lcars/pull/703) fixed here is
structurally present there too (`agent-router.yml`'s `normalize` job holds a
repository-wide concurrency group). `supersprinklesracing/sprinkles`'s
`agent-router.yml` and `reconcile-dispatched-issues.yml` are a simpler,
ledger-less version of the same problem: naive `gh workflow run` dispatch
with no durable state at all, so a stranded issue is only caught by a
scheduled sweep counting marker comments.

Retiring Group A is a real capability question — _should_ `homelab` and
`sprinkles` issue dispatch flow through `agent-lcars`'s hosted controller as
a genuinely multi-repository authority, or stay local? — but it is a distinct
design decision from the rest of #864, not a new shared contract. It is
deliberately **not designed in this document or in the
`recovery-observation.ts` contract landing alongside it**, and needs its own
follow-up issue.

**Group B — the delivery-lifecycle domains #645 never covered.** CI retry,
PR healing, merge follow-through, deployment follow-through, and post-deploy
verification are all about what happens to a PR _after_ it is authored —
a lifecycle #645 was never scoped to cover (§"What is not another system"
lists GitHub Actions as "the launch/execution mechanism, not another source
of lifecycle truth," but says nothing about CI/deploy recovery for the
_artifact_ that mechanism produces). This is the genuine gap, and it is what
`libs/dispatch-contracts/src/recovery-observation.ts` (landing in this same
change) publishes a shared vocabulary for: `RecoveryDomain`,
`RecoveryOperationTarget`, and a stable operation key
(`recovery/v1:<domain>:<repositoryId>:<anchor>:<exactIdentity>`).

**Group C — already done right.** Both repositories'
`rerun-infra-killed-runs.yml` already consume
`jlapenna/agent-lcars/.github/actions/rerun-infra-killed-runs@main` directly —
the sanctioned dependency direction
([`docs/published-actions.md`](published-actions.md)) and the "thin,
idempotent execution adapter" shape #864 asks the rest of these workflows to
become. They are the working example, not a problem to fix.

## Group B inventory: trigger, decision, side effect, retry, idempotency today

| Repo      | Workflow                                           | Trigger                                                                                                                  | Decision                                                                                                                                                                                                                                                                                                  | Side effect                                                                                                                            | Retry policy                                                                            | Idempotency mechanism today                                                                                                                                                                                                                                                  | Domain                                                                     |
| --------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| sprinkles | `ci-auto-rerun.yml`                                | `workflow_run` `[CI, E2E]` completed                                                                                     | Rerun iff conclusion is `cancelled` and the run's commit is still the branch's current head                                                                                                                                                                                                               | `tools/ci-auto-rerun.sh` reruns the exact run                                                                                          | Implicit; no explicit cap, gated by the still-head check                                | **Already exact-identity based**: exact run ID plus a live head-SHA check, never an actor or a window                                                                                                                                                                        | `ci_retry`                                                                 |
| sprinkles | `claude-automerge.yml` (`restore-main-checks` job) | `workflow_dispatch` (explicit `pr`+`head_sha`), `workflow_run` `[CI, E2E]` success, or `pull_request` opened by an agent | Waits for both required checks green, waits for the merge, proves `main` descends from it, then bridges the suppressed `workflow_run` chain: dispatches missing `ci.yml`, waits for it, dispatches missing `deploy.yml`, waits for it, dispatches `post-deploy-verify.yml` with the exact `deploy_run_id` | `gh workflow run` for each missing stage, keyed to the exact safety SHA                                                                | None; single bounded (75 min) pass                                                      | **Already exact-identity based**: concurrency group `agent-postmerge-<sha>` plus an explicit "does a run already exist for this exact SHA" API check before each dispatch                                                                                                    | `merge_follow_through` → `deployment_follow_through` (one job spans both)  |
| sprinkles | `label-post-deploy-action.yml`                     | `pull_request` closed (merged)                                                                                           | Parse `<!-- status:post-deploy-action:#N -->` markers from the PR body                                                                                                                                                                                                                                    | Add `status:post-deploy-action` label to each declared issue                                                                           | **None** — single pass on the merge event; no scheduled sweep re-applies a missed label | Label add is naturally idempotent, but there is no recovery if this run itself fails or is skipped                                                                                                                                                                           | `deployment_follow_through`                                                |
| sprinkles | `post-deploy-verify.yml`                           | `workflow_run` `[Deploy (affected apps)]` completed, or `workflow_dispatch(deploy_run_id)`                               | Per open `status:post-deploy-action` issue: defer if an open PR still references it; defer unless every referencing merged PR's commit is an ancestor of the deployed-baseline marker SHA; skip if already dispatched for that exact SHA                                                                  | Comment + `gh workflow run agent-router.yml` (runbook `verifying-post-deploy`)                                                         | Implicit — an undeployed reference is simply picked up by a later run                   | **Already exact-identity based**: `post-deploy-verify-dispatch:<sha>` marker keyed on the latest deployed merge SHA — this is the literal shape `recovery_observation.ts`'s `post_deploy_verification` domain generalizes                                                    | `post_deploy_verification`                                                 |
| sprinkles | `pr-heal.yml`                                      | `workflow_run` `[CI, E2E]` failure/timeout, or `workflow_dispatch(pr, reason, reset_attempts)`                           | Guards: PR open, not draft, head unchanged since trigger, agent-authored or `automation:heal`-labeled, not `status:needs-human`, no already-live agent run; bounded by `attempts` read from a `pr-heal-ledger:v1` hidden comment                                                                          | Update ledger comment, dispatch `agent-router.yml` (runbook `healing-a-pr`); past `MAX_ATTEMPTS=2`, label `status:needs-human` instead | Bounded, 2 attempts, then escalate                                                      | Concurrency group `pr-heal-<PR>` (per-PR, not per-failure) plus a head-SHA staleness check — **a real gap**: two independent triggers for the _same_ failed head SHA each consume one attempt of the budget, because the ledger keys on PR number, not on `pr:<n>:<headSha>` | `pr_healing`                                                               |
| sprinkles | `reconcile-dispatched-issues.yml`                  | `schedule` (`*/30`), `workflow_dispatch`                                                                                 | Scan open `agent:*`-labeled issues with no live run, not yet claimed, past a 15-minute grace window; escalate contradictory (>1) `agent:*` labels immediately                                                                                                                                             | `gh workflow run agent-router.yml`, marker comment, escalate to `status:needs-human` past `MAX_ATTEMPTS=2`                             | Bounded, 2 attempts, then escalate                                                      | Global concurrency group (`reconcile-dispatched-issues`) plus a per-issue count of marker comments                                                                                                                                                                           | **`controller`/`reconciliation`** (existing #645 vocabulary — see Group A) |
| homelab   | `agent-router.yml`                                 | `issues`, `issue_comment`, `pull_request`, `workflow_dispatch(kind)`                                                     | Forked pre-cutover broker: `normalize` then `broker` via local `./.github/actions/dispatch-broker`                                                                                                                                                                                                        | Full ledger-comment dispatch, `workflow_run` launches                                                                                  | Whatever the pre-cutover broker did                                                     | Reserved per-issue concurrency namespace (pre-cutover design)                                                                                                                                                                                                                | **`controller`** (existing #645 vocabulary — see Group A)                  |
| homelab   | `dispatch-reconcile.yml`                           | `schedule` (`7,37 * * * *`), `workflow_dispatch`                                                                         | Read-only discovery via the same local broker, `operation: reconcile`; fires `kind: reconcile` back through `agent-router.yml` per candidate                                                                                                                                                              | `workflow_dispatch` calls into `agent-router.yml`                                                                                      | Delegated to `agent-router.yml`'s own broker                                            | Single global scan concurrency group                                                                                                                                                                                                                                         | **`controller`/`reconciliation`** (existing #645 vocabulary — see Group A) |

Group C (`rerun-infra-killed-runs.yml` in both repositories) is intentionally
omitted from the table above: it already delegates entirely to this repo's
published action and needs no inventory entry to justify changing it, because
nothing about it should change.

## What this lands, and what it deliberately does not

This change publishes `RecoveryDomain`, `RecoveryOperationTarget`, and
`formatOperationKey`/`parseOperationKey`/`buildRecoveryObservation` from
`@agent-lcars/dispatch-contracts` — migration plan step 2 ("add normalized
observations and stable operation keys ... for the remaining CI, PR, deploy,
post-deploy, and parking transitions"). Parking itself is deliberately not a
domain: both `pr-heal.yml` and `reconcile-dispatched-issues.yml` already
converge on the same shape #645 defined —
`RetryDisposition`/`needsMaintainer()` — once their attempt count is
exhausted, so parking is a disposition of a domain's outcome, not a domain of
its own.

It does **not** land:

- a hosted ingestion endpoint or storage for these observations (the remaining
  migration work) — a separate follow-up,
  scoped to this repository;
- any change to the eleven consumer workflows themselves — cutover requires
  write access this session does not have in
  `supersprinklesracing/sprinkles` or `jlapenna/homelab`, and per
  [`AGENTS.md`](../AGENTS.md) this repository's only sanctioned dependency
  direction is consumers importing agent-lcars's published contracts/actions,
  never the reverse;
- a decision on Group A (whether `homelab`/`sprinkles` issue dispatch should
  route through a genuinely multi-repository hosted controller, or stay
  local) — that is a real design question #864 bundled in with Group B's
  narrower gap, and deserves its own issue and its own explicit approval
  before any code follows it.

Follow-up work — the hosted-ingestion and cutover phases for Group B,
the Group A design decision, and the actual consumer-workflow changes in
`sprinkles`/`homelab` — should be tracked as separate issues once this
contract exists, filed in the repository each change belongs to.
