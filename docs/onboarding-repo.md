# Onboard a repository to the agent fleet

Use this runbook to add a repository to Agent LCARS. It is the entry point
for the whole process: console discovery, QueueExecutor capacity, GitHub Apps,
repository integration, and an end-to-end dispatch.

It deliberately coordinates the focused runbooks rather than copying them.
Those documents own their domains and should be updated there when the
underlying system changes:

- [Runner-autoscaler onboarding](onboarding-autoscaler.md) — registration,
  scale sets, and homelab deployment.
- [Console and telemetry onboarding](onboarding-console-and-telemetry.md) —
  protocol, telemetry, console configuration, and the telemetry IAM boundary.
- [Fleet credentials](fleet-credentials.md) — credential ownership, minting,
  and centrally owned Codex authentication.
- [Published actions](published-actions.md) — supported reusable workflows
  and composite actions.

## What “onboarded” means

A repository is onboarded only when all of the following are true:

1. The fleet and autoscaler GitHub Apps can access the repository.
2. A matching self-hosted runner scale set accepts jobs.
3. The repository has its label and local-instruction contract.
4. The console knows to watch the repository and QueueExecutor can report its
   telemetry.
5. A real issue dispatch reaches QueueExecutor and leaves useful,
   inspectable evidence.

Merging configuration or seeing a green check is not sufficient evidence
on its own.

## Before you start

Choose the owner, repository, and first provider(s). Confirm the repo is not
already covered by the relevant GitHub App installations, console config, or
autoscaler registration. Reuse the shared runner image and start with one
general-purpose pool unless measured workload needs a separate pool.

This work normally spans three independent changes:

| Surface           | Owner              | Outcome                                                    |
| ----------------- | ------------------ | ---------------------------------------------------------- |
| Agent LCARS       | this repository    | Console discovery, labels, and QueueExecutor authorization |
| Homelab           | `jlapenna/homelab` | QueueExecutor capacity and any approved infrastructure     |
| Target repository | new repository     | Labels, hooks, configuration, and validation               |

Use a dedicated worktree for every repository change. Do not make direct
deployments, Terraform/IAM changes, Firestore writes, or secret-value changes
without the specific maintainer approval those operations require. Never
print, commit, or paste a credential value into an issue, PR, terminal log,
or chat.

**Order matters: configure the target repository (step 1) before admitting it
to the control plane (step 4).** Admission lets the Console turn the
repository's webhook events into QueueExecutor work. There are no target
repository agent workflow callers.

## 1. Bootstrap the target repository

Open a target-repository PR for its label, hook, validation, and local
instruction contract; do not vendor fleet execution implementation.

- Add the thin `agent-automerge` and `repo-validation` callers. Keep
  repository validation runnable on GitHub-hosted runners so it can establish
  a baseline before self-hosted capacity is healthy.
- Add `.github/workflows/gitleaks.yml` before making the `gitleaks` context
  required. Start from homelab's pinned, full-history scanner shape: read-only
  `contents` and `pull-requests` permissions, `fetch-depth: 0`, a named
  `gitleaks` job, and a bounded timeout. Its workflow must run on pull
  requests and pushes to `main`; retain every `main` scan while cancelling
  superseded pull-request scans. Use the repository's approved runner and
  scanner integration, then prove the check appears on this bootstrap PR.
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

For provider telemetry and its evidence, follow the separate [console and
telemetry onboarding](onboarding-console-and-telemetry.md) runbook.

Merge this PR — and confirm the target repository's `main` branch carries the
merged label and instruction contract — before admitting it to the Console.

## 2. Give it runner capacity

Follow [runner-autoscaler onboarding](onboarding-autoscaler.md) in the
canonical homelab repository. Confirm QueueExecutor's shared runner pool has
capacity for the target repository's work. Add a dedicated pool only when
measured workload duration or isolation demands it. Add the repository to
homelab's `protect-main` ruleset module as
well. Every repository starts with required `gitleaks` and
`validate / repository validation` checks: secret scanning is the fleet's
minimum security baseline, and a reusable validation workflow has no consumer
until its result blocks merges. It must also retain linear history, protection
against force-push and deletion, and required review-thread resolution.
Terraform plan/apply remains a separately approved maintainer operation.

The registration uses the autoscaler GitHub App, not the fleet App. Its App
key belongs in the homelab encrypted secret store; it never belongs in this
repository or the target repository. After the homelab change deploys, verify
the real listener is polling for the new scale set. A configuration merge or
healthy container alone does not prove registration coverage.

## 3. Install both GitHub Apps

A maintainer performs this in GitHub’s App-installation UI. Add the target
repository to both installations:

- **Fleet App**: QueueExecutor dispatch authorization, claims, comments, pull
  requests, labels, and console reads.
- **Autoscaler App**: runner registration and scale-set listener.

Use least privilege: add the target repository while retaining the
installation's other approved repositories. The selected-repository list is
the installation's complete access set, so replacing it with just the new
repository would silently revoke access from existing fleet members. Verify
membership with an installation token and `/installation/repositories` rather
than assuming that an account-wide installation includes it. The exact App
identifiers and installation guidance live in
[fleet credentials](fleet-credentials.md).

## 4. Add the repository to Agent LCARS

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

The normal deployment path deploys the console after green CI on `main`.
Do not run a direct deploy merely to accelerate this step. Do this step only
after step 1 has merged and landed on the target repository's `main` — see
"Order matters" above.

## 5. Prove the complete path

Use a real, suitably scoped issue rather than a synthetic success check.

1. Apply exactly one `agent:*` routing label for an enabled lane.
2. Confirm the Console shows the QueueExecutor run and its dispatch marker;
   there is no target-repository provider workflow to inspect.
3. Confirm the agent acknowledges and reports through the shared protocol:
   claim, progress, handoff/parking when needed, and a durable deliverable.
4. Confirm the console shows the provider-appropriate telemetry and final
   archive after the run; do not treat an absent GitHub Actions workflow as a
   failure because none is dispatched.
5. If a provider is intentionally not credentialed yet, record its first named
   QueueExecutor failure as the known dark state. Do not call it onboarded for
   that provider until its credential and dispatch are proven.

## Handoff checklist

Before closing the onboarding work, record links to the three PRs, their
merged commits, the App-membership verification, QueueExecutor-capacity
evidence, Console admission, and the test dispatch. State which providers are
fully live, which are intentionally dark, and any maintainer-owned follow-up.

This evidence makes the next repository onboarding faster without turning an
old rollout’s incidental identifiers into a new repository’s instructions.
