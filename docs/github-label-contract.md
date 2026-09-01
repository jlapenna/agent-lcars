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
- `agent:*` selects an executor and means "take this over" -- on an issue,
  implement it and open a PR; on a pull request (Agent LCARS only today,
  #567), take the PR over and keep pushing commits to its branch. The
  serialized dispatch broker enforces that exactly one of `agent:claude`,
  `agent:codex`, or `agent:opencode` is present and dispatches that agent.
  Contradictory `agent:*` labels fail loudly instead of being tolerated or
  resolved by precedence, with one narrow self-heal exception: a manual
  GitHub UI relabel can momentarily leave two agent labels on an issue (the
  new one added before the old one is removed), and the broker resolves
  that transient window itself by honoring the newest label and removing
  the other before dispatching, rather than failing the run.
- `review:*` (pull requests only; declared fleet-wide since #1312 -- #567
  introduced it on Agent LCARS alone, while the native verifier's
  `MODE=review` support was already fleet-wide) asks an agent to leave a
  review on the diff instead of taking it over -- no commits pushed. Same one-of-three-and-only-within-its-own-namespace
  contract as `agent:*`, evaluated independently: a PR may carry an
  `agent:*` label, a `review:*` label, both, or neither, and each drives
  its own dispatch mode when applied.
- `agent-option:*` modifies an agent run without selecting the executor.
- `intake:*` and `bot:*` record provenance, not execution state.
- `automation:*` and `ci:*` are explicit workflow controls.
- `app:*` scopes work to a product or deployable application.
- `planning` marks an issue or pull request containing substantial planning,
  design, or proposal material. It has no workflow behavior, so the same
  marker can be used by future Agent LCARS integrations.

## Repository profiles

| Family            | Agent LCARS                              | Sprinkles                                         | Homelab                                  |
| ----------------- | ---------------------------------------- | ------------------------------------------------- | ---------------------------------------- |
| `type:*`          | All canonical types                      | All canonical types                               | All canonical types                      |
| `status:*`        | Ready, blocked, needs-human, post-deploy | Ready, blocked, needs-human, post-deploy          | Ready, blocked, needs-human, post-deploy |
| `agent:*`         | Claude, Codex, OpenCode                  | Claude, Codex, OpenCode                           | Claude, Codex, OpenCode                  |
| `review:*`        | Claude, Codex, OpenCode                  | Claude, Codex, OpenCode                           | Claude, Codex, OpenCode                  |
| `agent-option:*`  | Long run                                 | Long run                                          | Long run                                 |
| Intake/provenance | Quick task, Renovate                     | Quick task, Renovate                              | Quick task, Renovate                     |
| Automation/CI     | None                                     | Heal, unstick PRs, visual refresh, E2E, snapshots | None                                     |
| Apps              | Console, telemetry, runner autoscaler    | Sprinkles, OneCake, Primes                        | None                                     |
| Planning          | `planning`                               | `planning`                                        | `planning`                               |

Repository profiles deliberately share names without requiring every
repository to install every label. Agent LCARS reads each watched repository's
declared agent integrations; Homelab now declares the standard Claude, Codex,
and OpenCode workflows and therefore exposes initial assignment and dispatch
actions. An agent choice is immutable once the Work record is admitted; the
console does not offer a parallel reassignment path.

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
issues and pull requests according to the manifest. `--prune` deletes only
labels on a repository's `migrations`/`remove` lists — a live label that is
simply undeclared is left alone.

The daily `label-contract-audit.yml` job runs the full
`--apply --migrate --prune` sync per repository: bot-minted legacy labels
(Renovate re-creates defaults like `dependencies`, `javascript`, and `go` on
its own pull requests) self-heal instead of flapping the job red every day.
Because of that, every live label in a covered repository must either be
declared in the manifest or consciously listed for removal — an undeclared
label is invisible to the sync in both directions.
