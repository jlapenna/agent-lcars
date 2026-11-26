---
name: lcars-handoff
description: Hand off a branch and remaining work to an LCARS agent through a new GitHub issue. Use when the user asks to hand off work to LCARS or invokes $lcars-handoff.
---

# Hand off the current branch to LCARS

A request to run this handoff authorizes publishing the agreed work, filing one issue in the current repository, and dispatching that issue to LCARS. For a draft or preview, prepare the brief locally and stop there.

1. Identify the current checkout, its intended GitHub repository, branch, base, and any existing issue or PR. Check for a PR carrying the same work, including one from the current branch or linked to an existing issue. If one exists, stop before committing, pushing, filing, or dispatching. Report the PR URL and explain that continuation requires a PR-anchored LCARS trigger.
2. Check the installed `lcars work --help` for the issue-list and dispatch commands. Verify the target repository is eligible with the read-only `lcars work issues --tracker github --repo <owner/repo>` command. A successful empty list is sufficient. If eligibility is unknown or the check fails, stop before publication and report the blocker. For each existing issue that identifies the same work, run `lcars work owner '<owner/repo>#<number>'` and follow `lcars-usage` to reconcile active or unknown ownership before publishing or dispatching. Admission of a new issue cannot reserve the existing issue's work.
3. Follow local worktree and publishing rules. Review the staged and unstaged changes, untracked files, and commits that the push would expose. Commit only in-scope work and keep unrelated edits local. If the current checkout is on the base branch or detached, use a dedicated task branch in the repository's supported workflow.
4. Push the task branch to the GitHub repository that will own the new issue, using the usual hooks. Verify the exact commit with `git ls-remote --exit-code <remote> refs/heads/<branch>`. Record the remote branch, full SHA, base branch, and commit URL. Stop before filing if the revision the worker needs is unavailable there. For a handoff with no code changes, record the base revision the worker should start from.
5. Run the installed `handoff` skill for the user's requested focus. If unavailable, write the same brief to the session scratchpad or OS temp directory. Adapt the brief into a sanitized GitHub issue body with the goal, user decisions, branch and SHA, relevant issue links, verification results, remaining steps, and completion criteria. Include session attribution and a resume command where supported. Use repository-relative paths and links the recipient can access. Keep private files, transcript paths, credentials, and unrelated changes out of the issue and branch. Tell the worker to fetch the published ref, verify its SHA, and continue from that revision in a clean task checkout.
6. File one new issue using `gh issue create --repo <owner/repo> --title "<title>" --body-file <sanitized-brief>`. Save the issue URL and number. Use explicit Work dispatch as the single admission path and leave automatic dispatch labels off. If issue creation returns an ambiguous result, look for the matching issue and inspect its body before attempting creation again.
7. Use the pipeline the user requested, or the repository's configured default. If there is no documented preference, use Codex when available. Dispatch the issue using the same request ID and pipeline on retries:

   ```bash
   lcars work dispatch '<owner/repo>#<number>' --pipeline <pipeline> --request-id lcars-handoff-<number>
   ```

   Save the run ID and location from the response. If dispatch fails, keep the issue and branch, diagnose the error, and retry the same dispatch when appropriate. If no receipt can be verified, report the issue as filed and the dispatch as unconfirmed. Avoid alternate triggers after an ambiguous dispatch result.

Report the issue URL, branch and SHA, and dispatch receipt. Leave the published branch available for the receiving worker and stop local implementation once LCARS accepts the handoff. Use `lcars-usage` for event subscriptions if the user asks to monitor the run.
