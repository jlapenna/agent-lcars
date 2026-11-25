---
name: lcars-usage
description: Operate Agent LCARS and check work ownership before implementing a GitHub issue in an LCARS-enrolled repository. Use for interactive Work or session operations, fleet ownership checks, determining whether a task is an explicit LCARS dispatch, and diagnosing why an approved pull request is not merging. LCARS application development and control-plane internals have separate repository skills.
---

# Using Agent LCARS

Use the installed `lcars` CLI and the repository's current ownership rules.
Start with `lcars --help` and the relevant command's help rather than guessing
flags. The [operations guide](https://github.com/jlapenna/agent-lcars/blob/main/OPERATIONS.md)
owns Work API access, authentication and supported maintenance procedures.

## Interactive work versus fleet dispatch

An interactive maintainer session follows the user's request and reports
progress and decisions in the conversation. A request to work autonomously
is not an LCARS dispatch. Working in an enrolled repository, generic `CI`,
piped input, a non-TTY, and provider session IDs do not establish a dispatch.

Interactive work needs no fleet assignment, takeover comment, dispatch marker,
parking label, provider handoff or LCARS status cadence. A direct request from
the owning maintainer is a handoff; do not require them to repeat it in GitHub
metadata. Check current ownership before implementation in either mode.

Only an explicitly LCARS-dispatched worker follows the canonical
[agent protocol](https://github.com/jlapenna/agent-lcars/blob/main/agents/shared/skills/agent-protocol/reference/agent-protocol.md)
for claims, takeover, progress, parking, handoff and deliverable evidence.
The console owns the anchor claim and takeover; do not post a second claim or
claim a related issue merely because you inspected it. Read the protocol itself
when dispatched; this usage skill does not replace or duplicate it.

## Check issue ownership before implementation

For a repository enrolled in the LCARS control plane, query its authoritative
owner before starting or taking over issue work:

```bash
lcars work owner '<owner/repo>#<number>'
```

- `fleet-run` or `interactive-session` owned by someone else means do not
  start a competing implementation. Coordinate with the live owner or follow
  an explicitly authorized takeover.
- An incomplete answer (exit 1), authentication failure or unreachable service
  means **unknown**, not free. Diagnose read-only access; do not infer vacancy
  from old comments, assignment age, a local lock file or an absent pane.
- Reconcile human assignees, linked PRs and current sessions with the owner
  verdict. An assignee records responsibility; it does not prove a fleet run
  is still active. A human owner needs an explicit handoff.
- An ownership check is read-only. It does not authorize a claim, comment,
  assignment, cancellation or routing change. Inspection-only requests remain
  inspection-only. Agents only add assignees unless explicitly authorized
  otherwise and repository policy permits it.

[The fleet ownership contract](https://github.com/jlapenna/agent-lcars/blob/main/docs/product/fleet-orchestration-product-spec.md)
owns verdict semantics. After the ownership check, use the installed generic
`github-issue-workflow` for repository policy, worktree isolation, duplicate-work
checks and normal delivery. Recheck live ownership and issue/PR state when
resuming stale work or before publishing a long-running implementation.

## When an approved pull request is not landing

In an enrolled repository an approved pull request lands without a person,
whoever opened it. A person or agent author is never the reason: most PRs
under the maintainer's login are agent-written, and approval is the merge
gate. Do not tell the maintainer to merge it or describe that as the design.
Renovate and Dependabot PRs are the exception: they land through their own
automerge, never this sweep.

The landing path: a trusted approval makes the console run the repository's
`agent-automerge.yml` sweep, which arms squash auto-merge on every open,
same-repository, non-draft, non-parked PR that is agent-authored or approved,
except dependency-bot PRs (the [admission contract](https://github.com/jlapenna/agent-lcars/blob/main/docs/published-actions.md#published-reusable-workflows)).
A push to the base branch, a successful PR CI run and the daily schedule also
run it. GitHub then merges once the ruleset's required checks pass.

Diagnose from live state, in this order:

1. `gh pr view <N> --repo <owner/repo> --json isDraft,labels,reviewDecision,mergeStateStatus,autoMergeRequest,headRepository`.
   A draft, `status:needs-human`, a fork or a dismissed approval (a push
   after approving) explains a held PR; the remedy is the fix or re-review,
   not a manual merge.
2. Compare failing checks with the ruleset's required ones
   (`gh api repos/<owner/repo>/rules/branches/<base>`). A failing check the
   ruleset does not require does not block the merge.
3. With approval and required checks green but `autoMergeRequest` empty, read
   the latest `agent-automerge.yml` runs and their `reconcile-automerge` log
   (`Armed squash auto-merge for PR #N` or an error). A missing run after the
   approval, or a sweep that skipped an eligible PR, is a defect in the
   landing path: report or fix it there. Rerunning the sweep with
   `gh workflow run agent-automerge.yml --repo <owner/repo>` is the supported
   repair for a dropped event.

## Operate within the requested scope

Prefer supported CLI and Work API operations over database repair. Existing
credentials or operator scopes do not grant a new task: creation, cancellation,
redispatch, replies and schedule changes need authorization in the current
request or an applicable standing grant. Do not post updates or create fleet
work simply because you read this skill. Do not change credentials or machine
configuration to manufacture access.

Use the [saved-session workflow](https://github.com/jlapenna/agent-lcars/blob/main/.agents/skills/verifying-console-session/SKILL.md)
when the requested operation requires an authenticated console session. Keep
credentials and session state private. For application implementation, read
[agent-lcars-dev](https://github.com/jlapenna/agent-lcars/blob/main/.agents/skills/agent-lcars-dev/SKILL.md);
for dispatch/reconciliation internals, read
[lcars](https://github.com/jlapenna/agent-lcars/blob/main/.agents/skills/lcars/SKILL.md).
