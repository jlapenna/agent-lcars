# Agent LCARS documentation map

Use this index to retrieve the smallest current contract for a task.
[`../AGENTS.md`](../AGENTS.md) routes agent work and
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) maps system ownership.

## System and operations

| Need                                     | Canonical document                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| Dispatch ownership and failure routing   | [`lifecycle-systems.md`](lifecycle-systems.md)                             |
| Application/deployment/Homelab boundary  | [`deployment-boundary.md`](deployment-boundary.md)                         |
| Work API access and parked-item cleanup  | [`../OPERATIONS.md`](../OPERATIONS.md)                                     |
| Published actions and reusable workflows | [`published-actions.md`](published-actions.md)                             |
| CI control flags                         | [`ci-control-flags.md`](ci-control-flags.md)                               |
| Runner image publication                 | [`image-publish-routing.md`](image-publish-routing.md)                     |
| Nx remote cache                          | [`nx-remote-cache.md`](nx-remote-cache.md)                                 |
| App Hosting stale revision audit         | [`apphosting-stale-revision-audit.md`](apphosting-stale-revision-audit.md) |

## Identity, credentials, and security

| Need                             | Canonical document                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Fleet credentials                | [`fleet-credentials.md`](fleet-credentials.md)                                                            |
| IAM contract                     | [`iam-contract.md`](iam-contract.md)                                                                      |
| Bot identity formats             | [`bot-identity-formats.md`](bot-identity-formats.md)                                                      |
| GitHub App webhook events        | [`github-app-webhook-events.md`](github-app-webhook-events.md)                                            |
| GitHub label vocabulary          | [`github-label-contract.md`](github-label-contract.md)                                                    |
| E2E credential boundary          | [`e2e-security-boundary.md`](e2e-security-boundary.md)                                                    |
| Quick-task identity and evidence | [`quick-task-identity.md`](quick-task-identity.md) and [`quick-task-evidence.md`](quick-task-evidence.md) |

## Development and fleet adoption

Repeatable local procedures live in [`playbooks/`](playbooks/README.md), starting
with the [local console/control-plane SUT](playbooks/local-console-sut.md).

| Need                             | Canonical document                                                           |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Repository onboarding            | [`onboarding-repo.md`](onboarding-repo.md)                                   |
| Console and telemetry onboarding | [`onboarding-console-and-telemetry.md`](onboarding-console-and-telemetry.md) |
| Console visual system            | [`console-design-system.md`](console-design-system.md)                       |
| Fleet testing policy             | [`testing-policy.md`](testing-policy.md)                                     |
| E2E reliability and triage       | [`e2e-reliability.md`](e2e-reliability.md)                                   |
| Worker behavior enforcement      | [`worker-behavior-enforcement.md`](worker-behavior-enforcement.md)           |
| Worker qualification and rollout | [`worker-policy-rollout.md`](worker-policy-rollout.md)                       |
| OpenCode context limits          | [`opencode-context-limit.md`](opencode-context-limit.md)                     |

## Product specification

| Need                                      | Document                                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| Console product spec (part 1)             | [`product/console-product-spec.md`](product/console-product-spec.md)                         |
| Fleet orchestration product spec (part 2) | [`product/fleet-orchestration-product-spec.md`](product/fleet-orchestration-product-spec.md) |

## Plans, evidence, and generated contracts

- `superpowers/specs/` and `superpowers/plans/` record scoped designs and
  implementation plans. Reconcile them with the resulting code and canonical
  docs before treating them as current behavior.
- Dated audit and support-evidence documents describe the named observation,
  revision, and conditions; they are not live state.
- [`api/work-v1.openapi.json`](api/work-v1.openapi.json) is generated from the
  Work contract. Regenerate it through the repository command rather than
  editing it by hand.

## Documentation ownership rules

- Put current facts beside their semantic owner and link to them elsewhere.
- Keep runbooks focused on the current procedure, authority, failure
  interpretation, and recovery path; issues and PRs preserve chronology.
- Do not record live repository variables, fleet health, or deployed revisions
  as policy. Provide the command or API that reads them.
- Delete retired paths and duplicated doctrine instead of presenting competing
  instructions or adding synchronization machinery.
