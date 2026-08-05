# Stacked PRs: Priority Merge Train and Chain Collapse

This repo's "Protect main" ruleset squash-merges onto `main` and requires
branches to be up to date before merging
(`required_status_checks.strict_required_status_checks_policy`). That
combination is fine for one PR at a time, but under a batch of several
auto-merge-armed PRs — stacked (each based on the previous PR's branch) or
just independent PRs landing close together — it levies a real tax (see
issue #534, written up from the 2026-08-04 sweep, retro #521):

- **The squash tax.** Squash-merging a PR replaces all of its commits with
  one new commit on `main`. Every PR stacked on top of it now has its base
  branch deleted out from under it and its own pre-squash commits orphaned
  — a plain "Update branch" click produces a merge commit duplicating
  diffs, not a clean rebase. Each dependent needs a manual
  `git rebase --onto`.
- **The race.** Multiple auto-merge-armed PRs sitting on a moving `main`
  restart each other's required checks every time any one of them merges —
  every PR marks the others `BEHIND` and (if you update all of them at
  once) they all pay for a fresh CI run. Under a busy `main` this can
  starve the _oldest_ PR indefinitely, and every restart is a `Verify` run
  on the shared `lcars-ci` runner pool other work is also queuing for.

Two recipes below fix this: a **priority merge train** for while PRs are
still separate, and a **chain collapse** for the endgame once several are
fully reviewed and green. Both are operational workarounds, not a
structural fix — see the note on GitHub's native merge queue at the bottom.

## Priority merge train

Use this whenever more than one auto-merge-armed PR could race against a
moving `main` — a stacked dependency chain, or just several independent PRs
opened close together.

1. **Rank the PRs.** For a stacked chain, order is fixed: the PR whose base
   is `main` lands first, then its immediate dependent, and so on. For
   independent PRs, oldest first (that's the PR starvation would otherwise
   hit).
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

This serializes CI load to one PR's worth of restart cycles at a time
instead of every stacked PR racing every other one's restarts on every
`main` advance — measured during the 2026-08-04 sweep at roughly half the
`Verify` runs against the shared `lcars-ci` pool compared to leaving every
PR's auto-merge armed simultaneously and letting GitHub restart all of them
each time `main` moved.

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
its merge method — compatible with this repo's squash-only auto-merge
convention) is built to replace both recipes above: it batches queued PRs,
tests each batch against the latest `main` on a temporary ref, and only
merges what passes — the same guarantee as
`strict_required_status_checks_policy` without needing anyone to babysit
"Update branch" per PR. This repo does **not** have it enabled; issue #534
has a research writeup of what enabling it would require and the one
incompatibility found (see the issue and its linked PR for the details) as
a recommendation for the maintainer to act on, not something an agent
session should flip unilaterally — it's a ruleset change affecting every
future PR merge in the repo. Until it's enabled, use the recipes above.
