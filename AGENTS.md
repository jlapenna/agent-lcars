# Agent LCARS agent entry point

This is the routing layer for work in the Agent LCARS repository. Keep current
behavior in code, configuration, tests, generated contracts, and the document or
skill that owns the workflow; do not turn this file into a parallel manual.

## Start every task here

1. Read [`agent-lcars-dev`](.agents/skills/agent-lcars-dev/SKILL.md)
   completely. It owns mandatory worktree, git, verification, pull-request,
   deployment, infrastructure, and production-data guardrails.
2. Confirm the primary checkout is current using that skill's freshness and
   worktree procedure before diagnosing source.
3. Determine execution mode. Interactive maintainer work follows the direct
   request. Only an explicit LCARS dispatch follows
   [`agent-protocol`](.agents/skills/agent-protocol/SKILL.md); generic CI,
   piped input, or working in this repository does not establish a dispatch.
4. Use the routing table below to load only the context needed for the task.
5. Inspect the owning code, configuration, tests, and neighboring precedent
   before adding another representation.
6. Verify at the boundary the request cares about. Internal consistency, a
   browser journey, a published action, a runner image, and a live deployment
   require different evidence.

When guidance is missing or wrong, repair the smallest authoritative owner so
later runs retrieve one answer.

## Repository map

- `apps/console`: Next.js control plane, Work API, decision inbox, and session
  views.
- `libs/orchestrator` and `libs/work`: durable task/run state, admission,
  leases, scheduling, and completion contracts.
- `apps/runner-autoscaler`: QueueExecutor integration, direct-runner image,
  host readiness, and execution support.
- `apps/telemetry-watcher`: provider transcript and session telemetry.
- `apps/github-actions-exporter`: GitHub Actions metrics.
- `agents/shared/skills`: fleet-consumed worker protocol and session behavior.
- `.github/actions` and reusable workflows: fleet-consumed CI capabilities.
- `infra`: repository-owned GitHub and GCP policy declarations.
- `tools`: executable repository policy, contract checks, and operator helpers.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) for ownership and dependency
boundaries and [`docs/README.md`](docs/README.md) for the documentation index.

## Route context just in time

| Task or decision                                                      | Read before acting                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Any repository change                                                 | [`agent-lcars-dev`](.agents/skills/agent-lcars-dev/SKILL.md), then its [verification](.agents/skills/agent-lcars-dev/references/verify.md) and [PR](.agents/skills/agent-lcars-dev/references/pr.md) workflows when applicable |
| Headless worker behavior or deliverable lifecycle                     | [`agent-protocol`](.agents/skills/agent-protocol/SKILL.md); interactive sessions do not adopt its dispatch-only claim or cadence rules                                                                                         |
| Dispatch, reconciliation, telemetry, or auto-merge implementation     | [`lcars`](.agents/skills/lcars/SKILL.md) and [`docs/lifecycle-systems.md`](docs/lifecycle-systems.md)                                                                                                                          |
| Work API operations or parked native work                             | [`OPERATIONS.md`](OPERATIONS.md)                                                                                                                                                                                               |
| Deployment variables, credentials, or repository-vs-Homelab ownership | [`docs/deployment-boundary.md`](docs/deployment-boundary.md), [`docs/fleet-credentials.md`](docs/fleet-credentials.md), and [`docs/iam-contract.md`](docs/iam-contract.md)                                                     |
| Published actions or reusable workflows                               | [`docs/published-actions.md`](docs/published-actions.md)                                                                                                                                                                       |
| CI pause/arming flags or current state                                | [`docs/ci-control-flags.md`](docs/ci-control-flags.md); read live repository variables rather than trusting prose                                                                                                              |
| Tests, required checks, or E2E                                        | [`docs/testing-policy.md`](docs/testing-policy.md), [`docs/e2e-reliability.md`](docs/e2e-reliability.md), and the verification workflow                                                                                        |
| Console UI, theme, or route shell                                     | [`docs/console-design-system.md`](docs/console-design-system.md) before changing appearance                                                                                                                                    |
| Repository onboarding, labels, or identity                            | [`docs/onboarding-repo.md`](docs/onboarding-repo.md), [`docs/github-label-contract.md`](docs/github-label-contract.md), and [`docs/bot-identity-formats.md`](docs/bot-identity-formats.md)                                     |
| A failed or stuck agent run                                           | [`debug-agent-run`](.agents/skills/debug-agent-run/SKILL.md); [`issue-triage`](.agents/skills/issue-triage/SKILL.md) for a requested issue-queue audit                                                                         |
| Approved live authenticated console verification                      | [`verifying-console-session`](.agents/skills/verifying-console-session/SKILL.md)                                                                                                                                               |

`docs/superpowers/plans/` and the dated audit/evidence documents listed under
[plans and evidence](docs/README.md#plans-evidence-and-generated-contracts)
describe a specific design or observation. They are not automatically current
policy; reconcile them against live code and canonical contracts.

## Cross-repository and authority boundaries

- Member repositories consume the shared protocol, published actions, reusable
  workflows, and runner image from this repository. They keep their own domain
  facts locally. Do not restore byte-synced doctrine or cross-repository source
  imports.
- Homelab owns the running fleet, host configuration, execution credentials,
  and centralized apply paths. This repository owns LCARS application behavior,
  published interfaces, runner-image inputs, and its infrastructure
  declarations. Follow `docs/deployment-boundary.md` at the handoff.
- Shared runtime helpers come from `@jlapenna/fleet-runtime`; shared repository
  tooling and Nx-aware lint rules come from `@jlapenna/repo-tools`. Do not
  recreate local source copies.
- Secrets belong in GCP Secret Manager or the encrypted Homelab store.
  Terraform owns secret containers, never values. Capability to invoke a tool
  or workflow does not grant authority for deployment, Terraform, or Firestore
  mutation.
- The repository's `Protect main` ruleset declaration lives under
  `infra/github-ruleset`; change it through its reviewed path, never by editing
  GitHub policy out of band.

## Setup and discovery

- Primary checkout: `pnpm install` installs dependencies and git hooks.
- Linked worktree: run `./tools/setup-worktree.sh`.
- Use `./tools/nx` and query unfamiliar projects or flags with
  `./tools/nx show project <name> --json` or `./tools/nx <command> --help`.
- Search tracked source with `rg` and `rg --files`; avoid recursive scans
  through caches and dependency trees.

## Maintaining the harness

- Put invariants in the earliest owner that can enforce them: type/API/state
  machine, then executable test/lint/policy, then concise context or runbook.
- Keep current contracts separate from chronology. Issues, PRs, and dated
  evidence preserve the event; canonical docs and executable owners preserve
  the lesson.
- Add a skill only for a concrete prompt-triggered workflow that benefits from
  progressive disclosure. Keep general repository work in `agent-lcars-dev`
  and dispatched-worker behavior in `agent-protocol`.
- Do not embed live operational state, retired paths, or copied member-repo
  facts in this root guide. Link to the owner or provide a read surface.
