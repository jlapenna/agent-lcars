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

5. **Resolve every review thread — replying is not enough.** The
   `Protect main` ruleset sets `required_review_thread_resolution: true`
   on its `pull_request` rule: a PR with any unresolved review thread
   (Codex or human) cannot merge, full stop, no matter how green its
   checks are or how long `gh pr merge --auto` sits queued. Posting a
   reply comment does not resolve the thread — GitHub tracks resolution
   as a separate boolean the REST API doesn't expose, so after replying,
   explicitly resolve it via GraphQL:

   ```bash
   gh api graphql -f query='
   query {
     repository(owner: "jlapenna", name: "agent-lcars") {
       pullRequest(number: <N>) {
         reviewThreads(first: 50) {
           nodes { id isResolved comments(first: 1) { nodes { body } } }
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
