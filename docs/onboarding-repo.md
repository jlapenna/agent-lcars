# Onboard a repository to the agent fleet

Use this runbook to add a repository to Agent LCARS. It is the entry point
for the whole process: console discovery, runner capacity, GitHub Apps,
repository workflows, credentials, and an end-to-end dispatch.

It deliberately coordinates the focused runbooks rather than copying them.
Those documents own their domains and should be updated there when the
underlying system changes:

- [Runner-autoscaler onboarding](onboarding-autoscaler.md) — registration,
  scale sets, and homelab deployment.
- [Console and telemetry onboarding](onboarding-console-and-telemetry.md) —
  protocol, telemetry, console configuration, and the telemetry IAM boundary.
- [Fleet credentials](fleet-credentials.md) — credential ownership, minting,
  and repository-scoped Codex authentication.
- [Published actions](published-actions.md) — supported reusable workflows
  and composite actions.

## What “onboarded” means

A repository is onboarded only when all of the following are true:

1. The fleet and autoscaler GitHub Apps can access the repository.
2. A matching self-hosted runner scale set accepts jobs.
3. The repository has thin workflow callers, its required configuration, and
   its label contract.
4. The console knows to watch the repository; Claude telemetry is wired when
   that lane is enabled.
5. A real issue dispatch reaches the intended runner and leaves useful,
   inspectable evidence.

Merging configuration or seeing a green workflow is not sufficient evidence
on its own.

## Before you start

Choose the owner, repository, and first lane(s). Confirm the repo is not
already covered by the relevant GitHub App installations, console config, or
autoscaler registration. Reuse the shared runner image and start with one
general-purpose pool unless measured workload needs a separate pool.

This work normally spans three independent changes:

| Surface           | Owner              | Outcome                                                                   |
| ----------------- | ------------------ | ------------------------------------------------------------------------- |
| Agent LCARS       | this repository    | Console discovery, labels, and published-action inventory                 |
| Homelab           | `jlapenna/homelab` | Autoscaler registration, runner capacity, and any approved infrastructure |
| Target repository | new repository     | Thin workflow callers, hooks, configuration, and validation               |

Use a dedicated worktree for every repository change. Do not make direct
deployments, Terraform/IAM changes, Firestore writes, or secret-value changes
without the specific maintainer approval those operations require. Never
print, commit, or paste a credential value into an issue, PR, terminal log,
or chat.

## 1. Add the repository to Agent LCARS

Open one PR in this repository to make the control plane recognize the new
repository:

- Add the repository’s label manifest to `config/github-labels.json`, using
  the fleet’s standard `type:*`, `status:*`, `agent:*`, and `review:*` labels.
- Add it to both console settings in `apps/console/apphosting.yaml`:
  `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES` and
  `AGENT_LCARS_WATCHED_REPOS`. Use the repository name as its console alias
  unless a distinct human-facing alias is needed.
- Add it to the matrix in `.github/workflows/label-contract-audit.yml`; a
  manifest entry without this matrix entry will not be reconciled.
- Update the consumer list in `docs/published-actions.md`.

The normal deployment path deploys the console after green CI on `main`.
Do not run a direct deploy merely to accelerate this step.

## 2. Give it runner capacity

Follow [runner-autoscaler onboarding](onboarding-autoscaler.md) in the
canonical homelab repository. Add a registration for the target repository
and a starter scale set named and labeled for that repository. A practical
starting point is an ephemeral, general-purpose pool with a minimum of zero
and a small maximum; split pools only when workload duration or isolation
demands it.

The registration uses the autoscaler GitHub App, not the fleet App. Its App
key belongs in the homelab encrypted secret store; it never belongs in this
repository or the target repository. After the homelab change deploys, verify
the real listener is polling for the new scale set. A configuration merge or
healthy container alone does not prove registration coverage.

## 3. Install both GitHub Apps

A maintainer performs this in GitHub’s App-installation UI. Add the target
repository to both installations:

- **Fleet App**: dispatch lanes, claims, comments, pull requests, labels, and
  console reads.
- **Autoscaler App**: runner registration and scale-set listener.

Use least privilege: select only the repository being onboarded. Verify
membership with an installation token and `/installation/repositories` rather
than assuming that an account-wide installation includes it. The exact App
identifiers and installation guidance live in
[fleet credentials](fleet-credentials.md).

## 4. Bootstrap the target repository

Open a target-repository PR that consumes the fleet’s published artifacts;
do not vendor copies of their implementation.

- Add thin callers for the enabled Claude, Codex, and/or OpenCode lanes. They
  call the reusable workflows from `jlapenna/agent-lcars@main` and retain only
  repository-specific triggers, permissions, concurrency, inputs, and
  configuration.
- Add the thin `agent-automerge` and `repo-validation` callers. Keep
  repository validation runnable on GitHub-hosted runners so it can establish
  a baseline before self-hosted capacity is healthy.
- Add the issue-workflow guardrail hook to `.claude/settings.json` and
  `.codex/hooks.json`, and the `repo-require-worktree` check to the
  repository’s Git hook mechanism. The published workflow documentation owns
  the exact supported caller shapes.
- Add or refresh `AGENTS.md`. It should link to the shared fleet protocol and
  distinguish fleet-specific commands from public `repo-tools` commands; it
  must not copy either instruction set into the repository.
- Do not add a project `opencode.json` unless a setting is genuinely local to
  that repository. The shared runner image already supplies its fleet-wide
  OpenCode configuration.

For Claude telemetry, follow the separate [console and telemetry
onboarding](onboarding-console-and-telemetry.md) runbook. Telemetry is
currently Claude-only; do not wire its fail-soft sidecar into Codex or
OpenCode workflows expecting transcript data.

## 5. Configure repository variables and secrets

Configure the shared workflow contract in the target repository. The
currently required repository variables are:

| Variable                | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| `AGENT_LCARS_CLIENT_ID` | Fleet App token minting                          |
| `AGENT_FLEET_LOGIN`     | Fleet claim identity                             |
| `MAINTAINER_LOGIN`      | Human escalation and review routing              |
| `AGENT_BOT_LOGINS`      | REST-shaped bot identities allowed to auto-merge |
| `AGENT_RUNNER_LABEL`    | The target repository’s autoscaler label         |

The enabled lane determines the required secrets and cloud admission. Use
[fleet credentials](fleet-credentials.md) as the source of truth for exact
values, write paths, and ownership:

- Claude reads the fleet’s shared subscription token at run time, but the new
  repository must be admitted to the shared workload-identity pool.
- Codex requires an independent, repository-scoped `auth.json` lineage and
  its own restricted cloud identity; never reuse another repository’s object.
- OpenCode needs its repository Actions secret from the approved encrypted
  source.

List variable and secret _names_ after provisioning to confirm every write
landed. Do not retrieve values as a verification shortcut.

## 6. Prove the complete path

Use a real, suitably scoped issue rather than a synthetic success check.

1. Apply exactly one `agent:*` routing label for an enabled lane.
2. Confirm the dispatched workflow’s run name includes the control-plane
   dispatch marker and that its job runs on the target repository’s scale-set
   label.
3. Confirm the agent acknowledges and reports through the shared protocol:
   claim, progress, handoff/parking when needed, and a durable deliverable.
4. For Claude, confirm the console shows the live session and its finalized
   transcript after the run. For other lanes, confirm the expected workflow
   and GitHub evidence without treating absent Claude telemetry as a failure.
5. If a lane is intentionally not credentialed yet, record its first named
   failing step as the known dark state. Do not call it onboarded for that
   lane until its credential and dispatch are proven.

## Handoff checklist

Before closing the onboarding work, record links to the three PRs, their
merged commits, the App-membership verification, listener evidence, variable
and secret-name inventory, and the test dispatch. State which lanes are
fully live, which are intentionally dark, and any maintainer-owned follow-up.

This evidence makes the next repository onboarding faster without turning an
old rollout’s incidental identifiers into a new repository’s instructions.
