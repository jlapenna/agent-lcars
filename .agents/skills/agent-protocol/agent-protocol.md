# Agent Protocol — Cross-Repo Conventions

The conventions any headless remote coding agent follows when it is dispatched
against a GitHub issue or pull request — labeled-issue kickoff, an
`@mention`/slash-command reply, or an equivalent trigger. This file is
**generic on purpose**: it names no repo, no bot username, no CI check, and
no build tool. A repo that pulls this file in also maintains its own
repo-specific delta skill (naming its fleet-claim identity, its reviewer,
its verify commands, its own hard limits) and points to both from its
dispatch workflow's prompt — read that file too, and let it take precedence
wherever the two disagree.

This repo (`agent-lcars`) is both a consumer of this file (see
`.github/workflows/claude.yml` / `opencode.yml` and
`.agents/skills/lcars/lcars-protocol.md`) and, being the fleet's own
operations console, a **reader** of the conventions below: `apps/console`
parses the takeover command, the `human-needed` label, and the fleet-claim
assignee straight out of GitHub state produced by agents following this
protocol. Where this file states something as fixed vocabulary (not a
per-repo parameter), it is fixed because the console — or another
cross-repo consumer — depends on the exact string.

## 1. Takeover comment — your first action

Before reading anything else, post a brief comment on the anchor
(`gh issue comment`, or `gh pr comment` if the anchor is a pull request)
acknowledging you have picked it up. Include a copy-pasteable resume command
so the maintainer can take over your session from a runner host:

```
tools/claude-agent-session.sh resume <session-id>
```

Find `<session-id>`: the basename (without extension) of the newest session
transcript file under your CLI's own session-storage directory (e.g.
`~/.claude/projects/<slugified-repo-path>/*.jsonl` for Claude Code — use the
equivalent for whichever agent CLI is actually running).

**The script name is fixed protocol vocabulary, not a per-agent template.**
It is tempting to name this script per agent (`opencode-agent-session.sh`,
`codex-agent-session.sh`, …) so a repo running several pipelines can tell
them apart, but the fleet console's takeover-command scanner hard-codes the
literal substring `claude-agent-session.sh` (see `apps/console/src/lib/
action-items.ts`'s `TAKEOVER_COMMAND_RE` in this repo) — it does not
generalize per agent today. A resume command for any other filename will
never surface in the console UI, regardless of which agent posted it. Until
that regex is generalized, name the script `tools/claude-agent-session.sh`
relative to your repo root if you want console pickup, even for a
non-Claude pipeline. The path _prefix_ is free-form (the regex wildcards
it) — only the trailing filename is fixed.

## 2. Eyes-reaction acknowledgement

As you read the anchor's thread, add an eyes (👀) reaction to the body and to
every comment you have processed, so the maintainer can see what you have
seen:

```bash
gh api repos/$GITHUB_REPOSITORY/issues/<N>/reactions -f content=eyes
gh api repos/$GITHUB_REPOSITORY/issues/comments/<comment-id>/reactions -f content=eyes
```

## 3. One edited progress comment

Keep ONE continuously edited status comment per run
(`gh issue comment --edit-last`, or `gh pr comment --edit-last` on a PR
anchor), updated at plan time and at each milestone — never a stream of new
comments. Your takeover comment from §1 can serve as this same comment; edit
it in place rather than starting a second one.

## 4. Parking — blocked on a human

Whenever you are blocked on something only the maintainer can do (a
decision, an approval, access you do not have), park before ending your
turn. All parts are mandatory:

1. A comment saying exactly what you need, ending with a **bold reminder of
   the exact reply trigger your pipeline listens for** (e.g. `@claude`, or
   `/opencode`/`/oc` — check your own dispatch workflow's `if:` condition
   for the real string; a plain reply with no trigger is silently ignored).
2. The label **AND** the assignee — the assignee puts the ball visibly in
   the maintainer's court:

   ```bash
   gh issue edit <N> --add-label human-needed --add-assignee <maintainer-login> 2>/dev/null \
     || gh pr edit <N> --add-label human-needed --add-assignee <maintainer-login>
   ```

   `human-needed` is **fixed protocol-level vocabulary, not a per-repo
   parameter** — the fleet console parses this exact label name across every
   watched repo to build its "needs a human" queue. Do not rename or
   localize it per repo. `<maintainer-login>` is repo-specific; see your
   repo's delta skill.

3. Then stop — do not keep iterating on a parked item.

Do NOT park just because a PR is open awaiting normal review — that is
expected, not a block. Un-park yourself when you become unblocked (e.g. the
maintainer replied, or you found another way):

```bash
gh issue edit <N> --remove-label human-needed 2>/dev/null \
  || gh pr edit <N> --remove-label human-needed
```

## 5. Deliverable rule — silence is failure

Every dispatch ends with a visible artifact on the anchor: a PR
opened/updated, an evidence or summary comment, a close with comment, or a
park per §4. **A run that reasons to a conclusion and never posts it or acts
on it is a failed run, full stop** — internal reasoning that never reaches
GitHub state does not count, no matter how correct it was. Consuming
workflows should enforce this mechanically with a post-run
deliverable-evidence check that fails the job when no such artifact exists;
do not rely on the agent's own goodwill alone.

## 6. Push early — never hold finished work locally

Commit and push as soon as the smallest coherent slice of work exists (it
compiles, its directly-affected tests pass) — then keep iterating on that
same pushed branch. Never hold finished work locally waiting for a final
end-of-run verification pass before pushing anything. The run can be killed
or can exhaust its turn/time budget at any moment, and every unpushed byte
is lost with it — this is not a hypothetical, it is the single most common
way a headless run silently loses real, correct work.

## 7. Budget discipline

State your job's hard timeout up front (check your own workflow's
`timeout-minutes`) and pace your work against it. **A timeout-kill posts
nothing on its own** — the run is simply cancelled, so if you have not
already pushed work and posted a status comment before you'd hit the wall,
nothing survives. Build your own reporting in well before the deadline, not
only at the very end.

Apply a **one-diagnosis-one-targeted-action** rule when fixing a failure:
diagnose, apply one targeted fix, and re-check. If the same failure
signature recurs after that targeted fix, stop and escalate (park per §4)
rather than blind-iterating — repeated guessing burns the budget without
converging and is indistinguishable, from the outside, from a stuck run.

## 8. CI reruns and the bot-push / `action_required` platform fact

- If your own push triggers a failing CI check, you can usually rerun it
  yourself rather than parking: `GH_TOKEN=$ACTIONS_RERUN_TOKEN gh run rerun
<run-id> --failed`. Your default token typically cannot rerun workflows;
  a workflow that wants to grant this exports its own `GITHUB_TOKEN`
  (which carries `actions: write`) as `$ACTIONS_RERUN_TOKEN` for exactly
  this purpose — check whether your dispatch workflow does.
- **Platform fact:** GitHub holds the Actions run resulting from a
  bot-authored push (or a PR opened by one) as `action_required` with
  **zero check runs minted**, regardless of billing state or fork status.
  This is a GitHub Apps/bot-identity gate, not a bug in any one repo's
  config. A bot-class token — including a workflow's own `GITHUB_TOKEN` —
  **cannot self-approve** a held run; the approve API refuses bot-class
  tokens outright.
- **Recommended pattern:** a repo that dispatches bot-authored pushes
  should run a small watchdog workflow, on a schedule, that approves held
  runs on open PR heads using a **human-actor token** (a PAT or equivalent
  belonging to an actual user account, not the bot). Do not attempt to
  approve a held run yourself from within a headless agent run — you do
  not have a token capable of it. If checks are still empty well after the
  watchdog should have run, park per §4 naming this exact gate as the
  blocker.

## 9. Headless-synchronous rule

This is a headless CI run: the process exits the moment you end your turn,
and nothing resumes later. Work strictly synchronously — never launch
background subagents, never schedule wakeups or otherwise wait for
something to finish later, and never treat your own reasoning as if a user
just replied (no live user is watching; questions go through §4, they do
not get answered inline). A "success" conclusion on the job itself is not
proof anything was delivered — see §5.

## 10. GitHub Apps bot-identity assignment gotcha

The GitHub App bot identity your agent runs as (e.g. `claude[bot]`) is
**not an assignable GitHub user**. `gh issue edit --add-assignee @me` (or
any equivalent "assign myself" call) silently no-ops for it: the assignees
REST API drops any login that is not a real assignable account, and App
identities are never assignable. This is a universal GitHub Apps platform
limitation, not specific to any one bot or repo — do not spend time
debugging why "assign myself" did nothing before checking for this.

The fix is not to work around the API — it is to assign a different,
ordinary bot **user** account that repo uses to track fleet ownership, via
the assignees REST endpoint directly:

```bash
gh api "repos/$GITHUB_REPOSITORY/issues/<N>/assignees" \
  -f 'assignees[]=<fleet-tracking-login>' --silent
```

`<fleet-tracking-login>` is repo-specific (or, for a shared fleet, may be the
same login across every repo the fleet works) — see your repo's delta skill
for the exact login to use here.

## 11. Hard limits

Regardless of dispatch path:

- Never `--no-verify`.
- Never force-push without `--force-with-lease` (never plain `--force`).
- Never edit `.github/workflows/*`. Flag workflow-layer root causes in your
  report instead of trying to fix them yourself — and note that this is not
  only policy: the default `GITHUB_TOKEN` a workflow runs with is
  platform-restricted from pushing changes to workflow files at all, so an
  attempt to do so will fail regardless.
- Never deploy.
- Never touch IAM/permissions.

Your repo's delta skill may add further, repo-specific hard limits (a
protected infra directory, a deploy pipeline that must run some other way,
etc.) — those are additive to this list, never a relaxation of it.
