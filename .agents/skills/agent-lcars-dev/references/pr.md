# Pull Request Workflow

1. Do the work in a dedicated feature worktree (see
   [SKILL.md](../SKILL.md#hard-guardrails)'s checkout-safety guardrail) —
   never on `main`, never in the primary checkout.
2. Run [verify.md](verify.md) before opening or updating the PR.
3. Open the PR with `jlapenna` as reviewer:

   ```bash
   gh pr create --reviewer jlapenna
   ```

   `jlapenna` is this repo's maintainer for every purpose a PR review, a
   parking assignee (see the [lcars](../../lcars/SKILL.md) skill for the
   headless-dispatch parking recipe), or a fleet-claim escalation might
   need — the same login across interactive and headless sessions.

4. A PR authored by one of the agent bot identities listed in the
   `AGENT_BOT_LOGINS` repo variable (currently `claude[bot]` and
   `agent-lcars[bot]`) squash-auto-merges once the ruleset's required
   `Verify` check goes green (`.github/workflows/agent-automerge.yml`) — see
   the [lcars](../../lcars/SKILL.md) skill for the exact mechanism and how
   to register a new pipeline's bot login. A human-authored or
   interactively-driven PR merges normally through GitHub's own review
   flow.

   **The `Protect main` ruleset is the only thing protecting `main`.** The
   classic branch protection that used to sit alongside it was retired on
   2026-08-10; `GET /repos/:owner/:repo/branches/main/protection` now
   returns 404 by design, and `GET /repos/:owner/:repo/rules/branches/main`
   is the authoritative view. Do not re-add classic protection: the two
   systems enforce the same branch independently and drifted apart in
   practice, and a violation names the rule without saying which system
   raised it, so the failure reads like a broken flag rather than policy.

   The ruleset itself is codified in
   [`infra/terraform/github.tf`](../../../infra/terraform/github.tf)
   (`github_repository_ruleset.protect_main`, issue #900) — change branch
   protection there and go through a reviewed `plan`/`apply`, not by hand
   through the GitHub UI or API. See
   [`infra/terraform/README.md`](../../../infra/terraform/README.md#github-ruleset-protect-main)
   for the credential story and the admin-bypass hazard.

   The ruleset enforces required `Verify`,
   `required_review_thread_resolution`, linear history, and no deletion or
   force-push. The up-to-date-branch policy is **non-strict** (harmonized
   with the sprinkles repo, 2026-08-11): an armed PR merges on green even
   if `main` moved after its checks ran — post-merge `Verify` on `main` is
   the safety net for stale-base breakage (this repo's own PR CI checks
   out the event revision as-is; the `merge-live-base` action published
   here is consumed by sprinkles' E2E, not by this repo's workflows).
   Admins (`RepositoryRole:5`) hold
   `bypass_mode: always` as a deliberate escape hatch; if an admin merge
   is ever refused, update the branch and let `Verify` re-run rather than
   reaching for a bigger hammer.

5. **Resolve every review thread — replying is not enough.** The
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
