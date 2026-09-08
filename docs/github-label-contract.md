# GitHub label contract

Agent LCARS owns the canonical label manifest for Agent LCARS, Sprinkles, and
Homelab in [`config/github-labels.json`](../config/github-labels.json). Labels
are GitHub-facing intent and classification metadata. Agent LCARS Work
Tasks/Runs own execution state; GitHub comments, assignees, and pull-request
state remain their respective artifact facts.

## Shared vocabulary

- `type:*` classifies the work. Prefer one primary type.
- `status:*` records durable workflow state. `status:needs-human` means a
  maintainer must take the next action; `status:blocked` means an external
  dependency or prerequisite is preventing progress. They are not aliases.
- `agent:*` requests the canonical executor to take the anchor over -- on an
  issue, implement it and open a PR; on a pull request, take the PR over and
  keep pushing commits to its branch. Apply one of `agent:claude`,
  `agent:codex`, or `agent:opencode`; conflicting requests are refused by
  immutable Work admission and never self-healed by label rewriting.
- `review:*` (pull requests only; declared fleet-wide since #1312 -- #567
  introduced it on Agent LCARS alone, while the native verifier's
  `MODE=review` support was already fleet-wide) asks an agent to leave a
  review on the diff instead of taking it over -- no commits pushed. Same one-of-three-and-only-within-its-own-namespace
  contract as `agent:*`, evaluated independently: a PR may carry an
  `agent:*` label, a `review:*` label, both, or neither, and each drives
  its own dispatch mode when applied.
- `agent-option:*` modifies an agent run without selecting the executor.
- `intake:*` and `bot:*` record provenance, not execution state.
- `automation:*` and `ci:*` are explicit workflow controls, and the one
  namespace an agent does not self-serve. They exist to make a run broader,
  more expensive, or more privileged than the repository's default -- a
  full-fleet E2E lane, a job permitted to commit generated files -- so an
  agent applies one only when a maintainer asks for it by name, never as its
  own verification choice. Sprinkles measured the cost of the other reading
  (supersprinklesracing/sprinkles#5244): one `ci:run-e2e` applied at
  `gh pr create` time bypassed affected-project selection, saturated the
  shared self-hosted runner fleet, and left that PR and unrelated ones
  blocked for six hours. A repository that declares a `ci:*` label inherits
  this rule; it does not need to rediscover it.
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
repository to install every label. Every watched repository uses the same
canonical Claude, Codex, and OpenCode integrations unless it explicitly opts
out with `agents: false`. An agent choice is immutable once the Work record is
admitted; the console does not offer a parallel reassignment path.

## State boundaries

- Assignees express ownership.
- `status:needs-human` is cleared by the authorized hand-back path, not inferred
  from the newest comment author.
- Agent LCARS Work Tasks/Runs express queued/running/completed execution
  state. GitHub Actions may report repository automation, but is not an agent
  lifecycle authority.
- GitHub's mergeability is authoritative. Sprinkles does not mirror conflicts
  into a durable `conflicting` label.
- Sprinkles auto-heal attempt counts live in one workflow-owned ledger comment,
  not in `heal:1` or `heal:2` labels.
- Sprinkles post-deploy work is correlated by a structured PR marker and a
  native child issue, not title or free-prose parsing.

## Tagged replies resume a parked session

An explicit `@claude`/`@agent`/`/codex`/`/oc` trigger is required for any
GitHub comment to dispatch anything -- an ordinary comment with no trigger
word does nothing, on any repository, on any anchor, parked or not (#1788).

Session continuity did not go away with that gate: when a **tagged**
comment lands on an issue or pull request whose latest run **parked** (or
finished normally), it resumes that agent's session with the comment as
its next turn instead of starting fresh -- see
`apps/console/src/lib/tagged-reply-resume.ts`. The outcome comment on a
parked run carries the agent's own question when the runner reported one,
so the thread shows what to answer before the maintainer replies. A tagged
comment while a run is still live is refused as busy, exactly like any
other trigger; a tagged comment on an anchor with no task yet still starts
work normally -- that is how work is started by comment in the first
place, and this resume path never gets in front of it.

The author gate is unchanged: only an `OWNER` or `MEMBER` comment
triggers anything, never a `Bot` comment -- load-bearing here specifically,
since the agent's own park comment is posted by a bot, so it can never
answer itself.

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
