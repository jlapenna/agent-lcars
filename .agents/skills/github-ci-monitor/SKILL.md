---
name: github-ci-monitor
description: Watches armed auto-merge PRs until they land or need attention. Use after `gh pr merge --auto`, when waiting for the Verify check on one or more PRs, or whenever a session would otherwise poll `gh pr view` in a loop.
---

# GitHub CI Monitor

After `gh pr merge --squash --auto`, the question a session actually has
is: **did my PRs land, and if not, what needs fixing?** An armed PR whose
`Verify` fails waits silently forever — auto-merge never fires and
nothing pings the session. `repo-watch-prs` closes that gap:

```bash
repo-watch-prs [--strict] [--interval <s>] <pr> [<pr>...]
```

In an agent session, run it as a **background task** so its exit
re-invokes you with the verdict — never poll manually in the foreground,
and never write an ad-hoc watch loop (they historically only caught
merge/DIRTY and let check failures sit for hours).

**Behavior:** polls every PR (default every 120s), prints a timestamped
line per state change, and exits at the first event that needs you:

| verdict (last stdout line)                      | exit | meaning / next action                                                                                                         |
| ----------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| `VERDICT ALL-MERGED`                            | 0    | every watched PR merged — proceed                                                                                             |
| `VERDICT ATTENTION <pr> dirty`                  | 2    | needs rebase onto main, re-push, still armed                                                                                  |
| `VERDICT ATTENTION <pr> behind`                 | 2    | with `--strict`, update the branch; ignored by default for this repo's non-strict policy                                      |
| `VERDICT ATTENTION <pr> checks-failed:<names>`  | 2    | failed or cancelled required checks — inspect with `gh run view --log-failed`; rerun flakes with `gh run rerun <id> --failed` |
| `VERDICT ATTENTION <pr> unresolved-threads:<n>` | 2    | checks are green but review threads remain unresolved — address and resolve them using the GraphQL workflow in `pr.md`        |
| `VERDICT ATTENTION <pr> closed-unmerged`        | 2    | someone closed it — find out why                                                                                              |

Transient `gh`/network errors are reported once and retried, never
treated as a verdict. There is no timeout: a quiet watch is the success
path, so let it run until it exits.

The watcher checks paginated review-thread state after required checks are
green. It keeps each attention reason as one whitespace-free token so agent
consumers can parse verdicts even when GitHub check names contain spaces.

This is the only copy of the watcher: it lives in public
[`jlapenna/repo-tools`](https://github.com/jlapenna/repo-tools), and consumer
repositories do not carry its script or skill body. Its Codex plugin loads the
same guidance and the package exposes `repo-watch-prs` on PATH, so sessions in
any repository run the identical command.
