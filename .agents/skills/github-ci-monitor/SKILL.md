---
name: github-ci-monitor
description: Watches armed auto-merge PRs until they land or need attention. Use after `gh pr merge --auto`, when waiting for the Verify check on one or more PRs, or whenever a session would otherwise poll `gh pr view` in a loop.
---

# GitHub CI Monitor

After `gh pr merge --squash --auto`, the question a session actually has
is: **did my PRs land, and if not, what needs fixing?** An armed PR whose
`Verify` fails waits silently forever — auto-merge never fires and
nothing pings the session. `watch-prs.sh` closes that gap:

```bash
.agents/skills/github-ci-monitor/scripts/watch-prs.sh [--interval <s>] <pr> [<pr>...]
```

In an agent session, run it as a **background task** so its exit
re-invokes you with the verdict — never poll manually in the foreground,
and never write an ad-hoc watch loop (they historically only caught
merge/DIRTY and let check failures sit for hours).

**Behavior:** polls every PR (default every 120s), prints a timestamped
line per state change, and exits at the first event that needs you:

| verdict (last stdout line)                     | exit | meaning / next action                                                                   |
| ---------------------------------------------- | ---- | --------------------------------------------------------------------------------------- |
| `VERDICT ALL-MERGED`                           | 0    | every watched PR merged — proceed                                                       |
| `VERDICT ATTENTION <pr> dirty`                 | 2    | needs rebase onto main, re-push, still armed                                            |
| `VERDICT ATTENTION <pr> checks-failed:<names>` | 2    | inspect with `gh run view --log-failed`; rerun flakes with `gh run rerun <id> --failed` |
| `VERDICT ATTENTION <pr> closed-unmerged`       | 2    | someone closed it — find out why                                                        |

Transient `gh`/network errors are reported once and retried, never
treated as a verdict. There is no timeout: a quiet watch is the success
path, so let it run until it exits.

## This repo's silent-wait the watcher cannot see

The `Protect main` ruleset sets `required_review_thread_resolution` — a
PR with any **unresolved review thread** sits queued forever with green
checks and a clean merge state, which this watcher reads as "still
waiting" ([pr.md §5](../agent-lcars-dev/references/pr.md) has the
GraphQL resolution recipe). If a watch stays quiet long after `Verify`
went green, check the PR's review threads before suspecting the watcher.

(Same script as the sprinkles repo's `github-ci-monitor` skill — keep
behavioral changes mirrored.)
