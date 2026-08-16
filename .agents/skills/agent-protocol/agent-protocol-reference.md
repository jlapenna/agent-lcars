# Agent Protocol — Situational Reference

The parts of [`agent-protocol.md`](agent-protocol.md) you need only after you
have hit the specific situation they describe. They were split out because
the main file is mandatory pre-work reading on every single dispatch, on
every provider, and a headless run that never touches CI reruns should not
pay for the section about them (agent-lcars#1210).

Section numbers match the main file exactly — cross-references to §8 and §10
from any repo still resolve to these.

## 8. CI reruns and the bot-push / `action_required` platform fact

- If your own push triggers a failing CI check, you can usually rerun it
  yourself rather than parking: `GH_TOKEN=$ACTIONS_RERUN_TOKEN gh run rerun
<run-id> --failed`. Your default token typically cannot rerun workflows;
  a workflow that wants to grant this exports a dedicated credential as
  `$ACTIONS_RERUN_TOKEN` for exactly this purpose — check whether your
  dispatch workflow does. If the variable is empty, the workflow did not
  grant it: park rather than retrying, because the failure will be an
  opaque `gh` error rather than a clear permission message.
- **What that credential deliberately is not:** it is never the workflow's
  own `GITHUB_TOKEN`. That token carries the job's full
  contents/issues/pull-requests write grant — the same class of credential
  a repo's own dispatch control plane uses to admit, complete, and
  reconcile work (in agent-lcars, `libs/orchestrator`'s Firestore-backed
  mutex; in a repo whose broker still authenticates a comment-based ledger,
  that comment) — so handing it to an agent would let agent-authored code
  rewrite the control plane's own state (agent-lcars#645). It is a
  separate, independently revocable credential granted the narrowest scope
  that can still rerun a workflow.
  Depending on what the platform can express, that scope may still be wider
  than "rerun only" — treat it as a credential you were given for one
  purpose, and use it for that purpose.
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
