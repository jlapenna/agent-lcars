# GitHub label contract

Agent LCARS owns the canonical label manifest for Agent LCARS, Sprinkles, and
Homelab in [`config/github-labels.json`](../config/github-labels.json). Labels
are a small public API: workflows may consume durable control labels, while
runtime facts stay in GitHub Actions, comments, assignees, and GitHub's native
pull-request state.

## Shared vocabulary

- `type:*` classifies the work. Prefer one primary type.
- `status:*` records durable workflow state. `status:needs-human` means a
  maintainer must take the next action; `status:blocked` means an external
  dependency or prerequisite is preventing progress. They are not aliases.
- `agent:*` selects an executor. Exactly one may be present. Adding
  `agent:claude`, `agent:codex`, or `agent:opencode` still dispatches that
  specific agent through the repository's router.
- `agent-option:*` modifies an agent run without selecting the executor.
- `intake:*` and `bot:*` record provenance, not execution state.
- `automation:*` and `ci:*` are explicit workflow controls.
- `app:*` scopes work to a product or deployable application.
- `planning` marks an issue or pull request containing substantial planning,
  design, or proposal material. It has no workflow behavior, so the same
  marker can be used by future Agent LCARS integrations.

## Repository profiles

| Family            | Agent LCARS                              | Sprinkles                                         | Homelab                                             |
| ----------------- | ---------------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `type:*`          | All canonical types                      | All canonical types                               | All canonical types                                 |
| `status:*`        | Ready, blocked, needs-human, post-deploy | Ready, blocked, needs-human, post-deploy          | Ready, blocked, needs-human                         |
| `agent:*`         | Claude, Codex, OpenCode                  | Claude, Codex, OpenCode                           | None; the console declares no dispatch integrations |
| `agent-option:*`  | Long run                                 | Long run                                          | None                                                |
| Intake/provenance | Quick task, Renovate                     | Quick task, Renovate                              | Renovate                                            |
| Automation/CI     | None                                     | Heal, unstick PRs, visual refresh, E2E, snapshots | None                                                |
| Apps              | Console, telemetry, runner autoscaler    | Members, OneCake, Primes                          | None                                                |
| Planning          | `planning`                               | `planning`                                        | `planning`                                          |

Repository profiles deliberately share names without requiring every
repository to install every label. Agent LCARS reads each watched repository's
declared agent integrations; Homelab remains visible in the console without
offering invalid dispatch or reassignment actions.

## State boundaries

- Assignees express ownership.
- `status:needs-human` is cleared by the authorized hand-back path, not inferred
  from the newest comment author.
- GitHub Actions and Agent LCARS telemetry express queued/running/completed
  execution state.
- GitHub's mergeability is authoritative. Sprinkles does not mirror conflicts
  into a durable `conflicting` label.
- Sprinkles auto-heal attempt counts live in one workflow-owned ledger comment,
  not in `heal:1` or `heal:2` labels.
- Sprinkles post-deploy work is correlated by a structured PR marker and a
  native child issue, not title or free-prose parsing.

## Synchronization

Run the audit from Agent LCARS:

```bash
pnpm check:labels
```

Reconciliation is intentionally staged:

```bash
node tools/sync-github-labels.mjs --apply
node tools/sync-github-labels.mjs --migrate
node tools/sync-github-labels.mjs --prune
pnpm check:labels
```

`--apply` only creates labels and fixes metadata. `--migrate` relabels open
issues and pull requests according to the manifest. Destructive removal is
reserved for the explicit `--prune` step after workflow changes have landed.
