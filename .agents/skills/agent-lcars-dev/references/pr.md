# Pull Request Workflow

1. Do the work in a dedicated feature worktree (see
   [SKILL.md](../SKILL.md#hard-guardrails)'s checkout-safety guardrail) —
   never on `main`, never in the primary checkout.
2. Run [verify.md](verify.md) before opening or updating the PR.
3. **Get an independent review before arming auto-merge** when the change
   touches a live system's contract — a runner image, a deploy playbook, a
   k3s/ARC manifest, the autoscaler's config schema, a migration, or
   anything a green `Verify` cannot exercise. Codex review is quota-limited
   and often posts nothing; do not treat its silence as approval. Launch a
   fresh reviewer agent (`pr-review-toolkit:code-reviewer`, or a sonnet
   subagent with the same brief) against the branch with a focused list of
   failure scenarios to check, and fix what it finds before arming. On
   2026-09-30/10-01 that step caught, in one day, an image whose `runner`
   uid was 1002 not 1001 (every e2e pod would have crash-looped), a k3s
   data-dir move that k3s cannot start from (absolute paths in its stored
   kubeconfigs), and a rescue path that would have rolled a healthy cluster
   back onto hour-old state — none of which CI could see.
4. For an interactive, human-driven change, open the PR with `jlapenna` as
   reviewer:

   ```bash
   gh pr create --draft --reviewer jlapenna
   ```

   **Reconcile GitHub's actual closing scope before ready/arming**, in both
   interactive and dispatched publication. Declare exactly which issues this
   revision fully completes after reviewing their required acceptance and latest
   comments; an unfinished runtime/deployment gate excludes that issue. Use
   `Tracks #N` for source-only or diagnostic work. Avoid negated closing phrases:
   PR #2447's “intentionally does not close #2209” still selected #2209 in
   GitHub's interpreted `closingIssuesReferences`.

   Publish new PRs as drafts, so the returned references can be checked before
   a ready-PR auto-merge backstop can arm delivery. Once the check and required
   review pass, mark the draft ready and arm through the existing path below.
   After publishing the body, run the shared read-only check against the exact
   reviewed/pushed head, immediately before marking ready or arming, and chain
   every dependent mutation to it with `&&` so a rejection makes the mutation
   structurally unrunnable. Never retype the guard and a mutation as separate
   statements or join them with `;`: on #2324 publication a semicolon-joined
   sequence without `errexit` ran `gh pr ready` after the check had already
   exited 1; the operator explicitly returned the PR to draft before
   delivery (issue #2534). That manual correction was not a GitHub scope gate.

   ```bash
   node agents/shared/skills/agent-protocol/scripts/check-pr-closing-references.mjs \
     jlapenna/agent-lcars "$pr_number" "$reviewed_head" none \
     && gh pr ready "$pr_number" -R jlapenna/agent-lcars
   # For fully accepted intentional closure, replace none with e.g.
   # jlapenna/agent-lcars#1234 (comma-separated for multiple completed issues).
   ```

   The check paginates actual returned references and requires exact agreement
   with the declared completion scope. A mismatch, unreadable/incomplete response,
   or changed head blocks ready/arming. Correct the body or other closing metadata
   and re-read; changing English prose alone is not proof that GitHub removed the
   link. Preserve legitimate closing references only after full scoped acceptance.
   If an already-armed PR has an unintended reference, disarm it while correcting
   the metadata; refresh feedback and this check before re-arming. Re-run after
   any head/body/closing-metadata or acceptance change. Retain the JSON readback
   in the handoff. This is closure-scope evidence, separate from review, required
   checks and protected merge evidence. For partial work, verify the tracking issue
   remains open after source landing; close it only when remaining acceptance is
   proven. The readback cannot lock concurrent body edits: re-read any observed
   metadata change before proceeding.

   Headless dispatched workers instead follow the shared
   [agent protocol](../../agent-protocol/SKILL.md): they do not request human
   review and arm squash auto-merge after opening a ready PR.

   `jlapenna` is this repo's maintainer for every purpose a PR review, a
   parking assignee (see the [lcars](../../lcars/SKILL.md) skill for the
   headless-dispatch parking recipe), or a fleet-claim escalation might
   need — the same login across interactive and headless sessions.

5. A PR authored by one of the agent bot identities listed in the
   `AGENT_BOT_LOGINS` repo variable (currently `claude[bot]` and
   `agent-lcars[bot]`) squash-auto-merges once the ruleset's required
   `Verify` check goes green (`.github/workflows/agent-automerge.yml`) — see
   the [lcars](../../lcars/SKILL.md) skill for the exact mechanism and how
   to register a new pipeline's bot login.

   A PR pushed under the maintainer's own login — every interactive Claude
   Code, Codex, or cloud session — is **not** armed by that workflow. Arm
   it yourself when the reviewed, pushed PR is open and ready (a draft cannot
   be armed), before watching CI or handing off. Interactive maintainer
   sessions use the **queue-only mutation**, never `gh pr merge --auto`:
   that CLI command can merge immediately under an administrator's bypass
   authority even without `--admin`. On #2298, the ready-event checks were
   still queued and the rules suite recorded a bypass with all four required
   checks missing. The flag alone does not prove protected delivery.

   Read back the PR state, draft flag and head. Match its head to the exact
   independently reviewed and pushed revision, then bind the mutation to that
   revision so a concurrent push cannot silently change what you arm:

   ```bash
   pr_number="<PR_NUMBER>"
   reviewed_head="<EXACT_REVIEWED_AND_PUSHED_SHA>"
   gh pr view "$pr_number" -R jlapenna/agent-lcars \
     --json id,state,isDraft,headRefOid,autoMergeRequest
   pr_node="$(gh pr view "$pr_number" -R jlapenna/agent-lcars --json id --jq .id)"
   node agents/shared/skills/agent-protocol/scripts/check-pr-closing-references.mjs \
     jlapenna/agent-lcars "$pr_number" "$reviewed_head" <declared-scope> \
     && gh api graphql \
     -f query='mutation($id: ID!, $head: GitObjectID!) {
       enablePullRequestAutoMerge(input: {
         pullRequestId: $id, expectedHeadOid: $head, mergeMethod: SQUASH
       }) {
         pullRequest { id state headRefOid autoMergeRequest { enabledAt mergeMethod } }
       }
     }' \
     -f id="$pr_node" -f head="$reviewed_head" \
     && gh pr view "$pr_number" -R jlapenna/agent-lcars \
     --json state,isDraft,headRefOid,autoMergeRequest
   ```

   Require an open, ready PR at `reviewed_head` before the mutation and a
   non-null SQUASH `autoMergeRequest` at that same head afterward. Execute the
   closing-scope guard and the arming mutation only as the `&&`-chained
   sequence above — a rejected, incomplete or changed-scope read must stop the
   chain, not merely precede it. This arms
   delivery; it does not declare checks passed. If queueing fails, re-read the
   exact PR/head and diagnose the error. Do not fall back to a direct/admin
   merge, relax checks or treat an unarmed PR as delivered. If the PR merged
   during the request, inspect its exact merge evidence and rules evaluation
   instead of assuming that the arming command enforced protection.

   For API errors, lost responses or Git publication stalls, follow
   [delivery-recovery.md](delivery-recovery.md) before retrying. It owns bounded
   sanitized diagnostics and exact-ref/state recovery; this workflow still
   owns the reviewed-head, queue-only and protection requirements. A
   deterministic state refusal is not one of those transport failures — see
   below before treating it as a retryable queueing error.

   **Preserve a valid queue across unchanged-head infrastructure retries.**
   When an already-armed PR at its independently reviewed `reviewed_head` fails
   only because the runner infrastructure behind a required check was preempted,
   cancelled or otherwise never evaluated — and source, closing scope,
   review/approval state and intended delivery are all unchanged — leave the
   existing `autoMergeRequest` in place. Retry that failed check at the same
   revision and let the required checks stay the merge gate; GitHub delivers the
   queued squash when that exact head goes green. Withdrawing a valid queue
   request to "start clean" is the sequencing mistake: it strands an
   already-green PR, and re-arming the unchanged head then refuses with
   `UNPROCESSABLE` (`Pull request ... is in clean status`) while the PR still
   reads OPEN/ready with all required checks green. Record that refusal as a
   state change, not transport loss: it repeats
   identically, so re-issuing it is a blind retry. Recover by qualifying the
   actual source composition at a fresh revision — merge current `main` into the
   branch so checks and queueing evaluate a head that can be queued — and by
   re-arming that new reviewed head through the sequence above. Never answer it
   with a direct/admin merge, relaxed or fabricated checks/statuses, a policy
   edit, or a new wrapper, credential or helper introduced merely to arm.
   Disarm only when the source, closing scope, review/approval state or
   intended delivery actually changes; recorded case
   [#2558](https://github.com/jlapenna/agent-lcars/issues/2558) on PR #2551
   after the infrastructure preemption in
   [Homelab #2369](https://github.com/jlapenna/homelab/issues/2369).

   Draft CI can short-circuit without exercising full verification. After a
   draft becomes ready, an old green summary is not full-gate evidence: use
   the ready-event run's actual full-verification result for that exact head.

   Auto-merge armed under the maintainer's login is the opt-in the fleet
   reconciler honours (it updates a `BEHIND` branch when `main` moves, see
   `stacked-prs.md`), and the merge lands under that login, so the
   push-triggered `main` workflows fire naturally with no recovery
   dispatch. Review requests and required checks gate the merge exactly as
   before; a session that ends without arming leaves a green PR waiting for
   a human click.

   **The `Protect main` ruleset is the only thing protecting `main`.** The
   classic branch protection that used to sit alongside it was retired on
   2026-08-10; `GET /repos/:owner/:repo/branches/main/protection` now
   returns 404 by design, and `GET /repos/:owner/:repo/rules/branches/main`
   is the authoritative view. Do not re-add classic protection: the two
   systems enforce the same branch independently and drifted apart in
   practice, and a violation names the rule without saying which system
   raised it, so the failure reads like a broken flag rather than policy.

   The ruleset itself is codified in this repository's
   [`infra/github-ruleset`](../../../../infra/github-ruleset/) root. Homelab
   supplies the trusted credentials, isolated backend configuration, reviewed
   operator pathway, and scheduled drift check; it does not own this repo's
   policy declaration. Change branch protection here and use that centralized
   `plan`/approved-apply path, not the GitHub UI or API. See
   [`infra/terraform/README.md`](../../../../infra/terraform/README.md#github-ruleset-protect-main)
   for the hand-over record and the admin-bypass hazard.

   The ruleset enforces required `E2E`, `Verify`,
   `Runner image pnpm-store seed`, and `repository-owned Terraform`,
   `required_review_thread_resolution`, linear history, and no deletion or
   force-push. The up-to-date-branch policy is **non-strict** (harmonized
   with the sprinkles repo, 2026-08-11): an armed PR merges on green even
   if `main` moved after its checks ran — post-merge `Verify` on `main` is
   the safety net for stale-base breakage (this repo's own PR CI checks
   out the event revision as-is; the `merge-live-base` action published
   here is consumed by sprinkles' E2E, not by this repo's workflows).
   Admins (`RepositoryRole:5`) hold `bypass_mode: always` as a deliberate
   escape hatch. It is not routine delivery authority. Keep interactive
   arming on the queue-only path above; if checks or queueing refuse an
   operation, diagnose and let the required checks run.

   After merging, identify the rules suite whose `after_sha` is the exact
   main merge commit (`GET /repos/jlapenna/agent-lcars/rulesets/rule-suites`,
   then `GET .../rule-suites/<id>`). Require `result: pass` and inspect the
   required-check evaluation before calling the merge protected. A `bypass`
   result is an actual delivery incident: record its failed evaluations and
   root cause, monitor current-main verification, and keep runtime acceptance
   open. It does not authorize rollback, deployment or a live policy edit.

6. **Resolve every review thread — replying is not enough.** The
   `Protect main` ruleset sets `required_review_thread_resolution: true`
   on its `pull_request` rule: a PR with any unresolved review thread
   (Codex or human) cannot merge, full stop, no matter how green its
   checks are or how long `gh pr merge --auto` sits queued. Posting a
   reply comment does not resolve the thread — GitHub tracks resolution
   as a separate boolean the REST API doesn't expose, so after replying,
   explicitly resolve it via GraphQL:

   ```bash
   # --paginate walks every page (a plain `first: 50` with no cursor
   # silently drops any thread past the 50th on a busier PR, resolved or
   # not — Codex review on #569).
   gh api graphql --paginate -f query='
   query($endCursor: String) {
     repository(owner: "jlapenna", name: "agent-lcars") {
       pullRequest(number: <N>) {
         reviewThreads(first: 50, after: $endCursor) {
           nodes { id isResolved comments(first: 1) { nodes { body } } }
           pageInfo { hasNextPage endCursor }
         }
       }
     }
   }'

   gh api graphql -f query='
   mutation {
     resolveReviewThread(input: {threadId: "<PRRT_...>"}) {
       thread { id isResolved }
     }
   }'
   ```

   Do this for every actionable thread once its fix is pushed, before
   assuming `--auto` will ever land the merge — a queued auto-merge gives
   no error and no signal that it's stuck on this.

7. After verifying the merge, follow the shared
   [worktree-hygiene workflow](https://github.com/jlapenna/repo-tools/blob/main/plugins/repo-tools/skills/worktree-hygiene/SKILL.md)
   for task cleanup. Use the repository's installed dependency from the primary
   checkout (run its normal setup after synchronizing the merge). From outside
   the target worktree, audit with
   `pnpm --dir <primary-path> exec repo-prune-merged-worktrees --repo <primary-path> --base origin/main <worktree-path>`;
   add `--delete` only for the completed task. The shared command owns merge,
   PR, cleanliness, lock and process checks and local branch deletion. Keep
   any refused target and investigate its reason. Synchronize the clean primary
   checkout as specified in this skill before updating its installed tooling.
