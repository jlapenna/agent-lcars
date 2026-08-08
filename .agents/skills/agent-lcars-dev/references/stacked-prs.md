# Stacked PRs: Priority Merge Train and Chain Collapse

This repo's "Protect main" ruleset squash-merges onto `main`. Its current
required-status-check rule does **not** require PR branches to remain up to
date (`strict_required_status_checks_policy: false`, verified 2026-08-08),
so independent auto-merge-armed PRs no longer restart merely because another
PR landed first. A true stack — each PR based on the previous PR's branch —
still levies a squash tax (see issue #534, written up from the 2026-08-04
sweep, retro #521):

- **The squash tax.** Squash-merging a PR replaces all of its commits with
  one new commit on `main`. Every PR stacked on top of it now has its base
  branch deleted out from under it and its own pre-squash commits orphaned
  — a plain "Update branch" click produces a merge commit duplicating
  diffs, not a clean rebase. Each dependent needs a manual
  `git rebase --onto`.
- **The strict-update race (historical unless re-enabled).** When the ruleset
  required branches to be up to date, multiple auto-merge-armed PRs on a
  moving `main` restarted each other's required checks every time one merged.
  Under a busy `main` that starved the oldest PR and multiplied `Verify` runs
  on the shared `lcars-ci` pool. The current non-strict rule removes that race
  for independent PRs; this section remains the recovery recipe if strict
  updates return.

Two recipes below handle the remaining stacked case: a **priority merge
train** while PRs are separate, and a **chain collapse** for the endgame once
several are fully reviewed and green. They also recover the historical
independent-PR race if strict updates are re-enabled. See the note on GitHub's
native merge queue at the bottom for the structural alternative.

## Priority merge train

Use this for a stacked dependency chain. If the ruleset is changed back to
requiring up-to-date branches, also use it for several independent PRs opened
close together; that extra serialization is unnecessary under the current
non-strict rule.

1. **Rank the PRs.** For a stacked chain, order is fixed: the PR whose base
   is `main` lands first, then its immediate dependent, and so on. Under a
   future strict-update rule, rank independent PRs oldest first (the PR that
   starvation would otherwise hit).
2. **Feed exactly one PR at a time — the current head of the train.**
   Only the head gets active attention: confirm its state directly rather
   than guessing —
   ```bash
   gh pr view <N> --json number,mergeStateStatus,statusCheckRollup,reviewDecision,mergeable
   ```
   Resolve any real review-thread feedback on it now (Codex threads catch
   real bugs here — an unresolved thread blocks the merge regardless of
   how green the checks are; see `required_review_thread_resolution` in
   the ruleset). Read every thread, fix issues on their merits, reply, then
   resolve via GraphQL:
   ```bash
   gh api graphql -f query='
     mutation($id: ID!) {
       resolveReviewThread(input: { threadId: $id }) { thread { isResolved } }
     }' -F id=<threadId>
   ```
3. **Park every other PR.** Leave their auto-merge disarmed (or just leave
   them alone) rather than letting all of them try to update against every
   advance of `main`:
   ```bash
   gh pr merge <parked-N> --disable-auto
   ```
   A short comment noting what it's parked behind (`parked behind #<head>`)
   keeps a concurrent session from re-arming it early.
4. **Wait for the head to actually merge** — poll state, don't infer it
   from one CLI message:
   ```bash
   gh pr view <N> --json state,mergedAt,mergeCommit
   ```
5. **Once it merges, advance the train.** The just-merged PR's branch is
   usually auto-deleted, but GitHub keeps every PR's last-pushed commit
   reachable forever at `refs/pull/<N>/head` — fetch that instead of racing
   to capture the tip before deletion:
   ```bash
   git fetch origin
   git fetch origin refs/pull/<merged-N>/head
   OLD_TIP=$(git rev-parse FETCH_HEAD)

   git checkout <dependent-branch>
   git rebase --onto origin/main "$OLD_TIP"
   git push --force-with-lease
   ```
   `--onto` replays only the commits unique to `<dependent-branch>` (the
   ones not already squashed into `origin/main`) directly on top of the new
   tip — this is the actual fix for the squash tax, not a merge commit.
   If the dependent PR's base pointed at the now-deleted branch rather than
   `main` directly, retarget it explicitly instead of trusting GitHub's
   automatic retarget-on-delete:
   ```bash
   gh pr edit <dependent-N> --base main
   ```
6. **Re-arm auto-merge on the new head** (`gh pr merge <dependent-N> --auto
--squash`) and go back to step 2 for it — and only it. Repeat until the
   stack is empty.

Under the former strict-update rule, this serialized CI load to one PR's
restart cycle at a time — measured during the 2026-08-04 sweep at roughly
half the `Verify` runs against the shared `lcars-ci` pool. For a stack under
today's rule, its purpose is ordering and clean squash-tax recovery rather
than preventing independent PRs from going `BEHIND`.

## Chain collapse

Once **three or more** PRs in a stack are each individually reviewed,
green, and have zero unresolved review threads, don't run them through the
train one at a time — collapse the whole chain into the bottom PR and pay
the CI cost once instead of once per PR.

Worked example from the same sweep: PR
[#494](https://github.com/jlapenna/agent-lcars/pull/494) was the bottom of
a four-PR chain (`#494 → #495 → #497 → #498`, inbox search → keyboard nav →
mute expiry → unified action labels). Each was reviewed and thread-resolved
individually on its own branch; the chain was then collapsed into #494
alone, cutting four serial CI cycles to one. #495/#497/#498 were closed
without merging, pointing back at #494, so their review history stayed
intact for anyone auditing later.

Recipe:

1. **Confirm every PR in the chain is actually ready** — reviewed, green,
   no unresolved threads. Collapsing skips redundant CI, never skips
   review; don't collapse a chain that still has an open thread on a
   middle PR.
2. **Fast-forward the bottom branch to the tip.** The branch backing the
   PR whose base is already `main` (the bottom of the stack) is an
   ancestor of the tip branch in a cleanly stacked chain, so this is a pure
   fast-forward, not a merge:
   ```bash
   git fetch origin
   git checkout <bottom-branch>          # backs the PR whose base is main
   git merge --ff-only origin/<tip-branch>
   git push origin <bottom-branch>
   ```
   If `--ff-only` refuses, the chain wasn't actually linear (a middle PR
   picked up commits the others don't have) — fix that first; don't force
   past it.
3. **Retitle and re-summarize the bottom PR.** It now diffs against `main`
   with the union of every PR's changes, so its title/body should describe
   the combined change and credit what each constituent PR reviewed (see
   #494's body for the pattern).
4. **Close every other PR in the chain without merging**, pointing at the
   survivor:
   ```bash
   gh pr close <mid-N> --comment \
     "Superseded by #<bottom-N>, which collapses this chain into one PR to cut CI cycles. Review history stays here for reference."
   ```
5. **Let the survivor run CI once and auto-merge normally** — it now
   carries the whole chain's diff through a single `Verify` run.

## On GitHub's native merge queue

GitHub's merge queue (a `merge_queue` ruleset rule, supporting `SQUASH` as
its merge method — compatible with this repo's squash convention) batches
queued PRs, tests each batch against the latest `main` on a temporary ref,
and only merges what passes. It provides the strict integration guarantee
without requiring each PR branch itself to be kept current.

This repo does **not** have the queue enabled. The current non-strict status
check rule already removes the independent-PR restart race, so enabling the
queue is now an integration-policy choice rather than the only fix for #534.
The issue's research records the remaining `restore-main-checks` integration
question. Changing the live ruleset affects every future merge and remains a
maintainer decision; until then, use the recipes above for actual stacks.
