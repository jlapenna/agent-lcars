---
name: lcars-handoff
description: Hand the current repository's in-progress branch and remaining work to an LCARS agent. Use when the user asks to hand off work to LCARS or invokes $lcars-handoff.
---

# Hand off the current branch to LCARS

A request to run this handoff authorizes publishing the agreed work, filing one issue in the current repository, and dispatching that issue to LCARS. For a draft or preview, prepare the brief locally and stop there.

1. Identify the current checkout, its intended GitHub repository, the branch, the base, and any existing issue or PR. Follow local worktree and publishing rules. Review the staged and unstaged changes, untracked files, and commits that the push would expose. Commit only in-scope work and keep unrelated edits local. If the current checkout is on the base branch or detached, use a dedicated task branch in the repository's supported workflow. Preserve any existing issue or PR and link it as context. If another actor is already implementing the same work, reconcile ownership using `lcars-usage` before dispatching.
2. Push the task branch to the GitHub repository that will own the new issue, using the usual hooks. Verify the exact commit with `git ls-remote --exit-code <remote> refs/heads/<branch>`. Record the remote branch, full SHA, base branch, and commit URL. Stop before filing if the revision the worker needs is unavailable there. For a handoff with no code changes, record the base revision the worker should start from.
3. Run the installed `handoff` skill for the user's requested focus. If unavailable, write the same brief to the session scratchpad or OS temp directory. Adapt the brief into a sanitized GitHub issue body with the goal, user decisions, branch and SHA, relevant issue or PR links, verification results, remaining steps, and completion criteria. Include session attribution and a resume command where supported. Use repository-relative paths and links the recipient can access. Keep private files, transcript paths, credentials, and unrelated changes out of the issue and branch. Tell the worker to fetch the published ref, verify its SHA, and continue from that revision in a clean task checkout. If a PR already exists, identify it and tell the worker to continue it.
4. File one new issue using `gh issue create --repo <owner/repo> --title "<title>" --body-file <sanitized-brief>`. Save the issue URL and number. Use explicit Work dispatch as the single admission path and leave automatic dispatch labels off. If issue creation returns an ambiguous result, look for the matching issue and inspect its body before attempting creation again.
5. Use the pipeline the user requested, or the repository's configured default. If there is no documented preference, use Codex when available. Check `lcars work --help` for the installed syntax. Dispatch the issue using the same request ID and pipeline on retries:

   ```bash
   lcars work dispatch '<owner/repo>#<number>' --pipeline <pipeline> --request-id lcars-handoff-<number>
   ```

   Save the run ID and location from the response. If dispatch fails, keep the issue and branch, diagnose the error, and retry the same dispatch when appropriate. If no receipt can be verified, report the issue as filed and the dispatch as unconfirmed. Avoid alternate triggers after an ambiguous dispatch result.

Report the issue URL, branch and SHA, and dispatch receipt. Leave the published branch available for the receiving worker and stop local implementation once LCARS accepts the handoff. Use `lcars-usage` for event subscriptions if the user asks to monitor the run.
