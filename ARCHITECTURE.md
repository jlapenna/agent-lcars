# Agent LCARS architecture and ownership

This document maps the durable system and harness boundaries. Follow
[`AGENTS.md`](AGENTS.md) for task routing and the owning source below for the
exact contract.

## System trajectory

An inbound GitHub event, native Work request, schedule tick, or reply enters the
console's Work API and orchestration layer. The orchestrator owns admission and
durable state, writes claimable queue work, and reconciles leases and outcomes.
QueueExecutor reserves capacity, launches the direct-runner environment, and
reports completion. The console exposes the resulting decisions, active runs,
and session evidence to maintainers.

```text
GitHub / Work API / schedule
            |
            v
  console + orchestrator ----> durable work/run/outbox state
            |                              |
            v                              v
       claimable queue ----> QueueExecutor / direct runner
                                      |
                                      v
                         provider session + deliverable evidence
                                      |
                                      v
                         completion / reconcile / console
```

## Ownership map

| Surface                                                 | Owns                                                                                           | Claim-matched evidence                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `apps/console/src/app/api/work`, console server modules | Authenticated Work API, webhook intake, operator and console surfaces                          | API contract tests, console build/E2E, live logs           |
| `libs/orchestrator`                                     | Task/run state machine, admission, leases, retry, reconciliation, outbox                       | Model/decision tests and store integration tests           |
| `libs/work`                                             | Shared Work API schemas and client-facing contracts                                            | OpenAPI freshness and consumer tests                       |
| `apps/runner-autoscaler` and direct-runner image        | Queue claims, capacity reservation, bootstrap, provider execution, completion reporting        | Go/contract tests, image checks, controlled smoke evidence |
| `apps/telemetry-watcher`                                | Transcript discovery, normalization, privacy scope, and session publication                    | Adapter tests and session evidence                         |
| `.github/actions` and reusable workflows                | Published fleet CI capabilities                                                                | Published-action contracts and member-repo consumer checks |
| `agents/shared/skills`                                  | Headless worker behavior consumed across the fleet                                             | Runtime loading tests and observed dispatched trajectories |
| `infra/github-ruleset` and `infra/terraform`            | Repository policy and GCP resource declarations                                                | Protected Terraform plan/apply path and drift checks       |
| Homelab                                                 | Running hosts, ARC/k3s, QueueExecutor deployment, credentials, and centralized apply execution | Homelab configuration checks and live platform health      |

## Dependency direction

Member repositories may consume Agent LCARS published actions, reusable
workflows, shared skills, protocols, and runner images. Agent LCARS does not
import their source or build contexts. Fleet-wide generic helpers are published
through `@jlapenna/fleet-runtime` and `@jlapenna/repo-tools`; small foundation
files may remain intentionally duplicated where no runtime dependency is
justified.

Homelab deploys and configures the runtime but does not become the semantic
owner of LCARS application behavior or repository policy. The precise
configuration handoff is documented in
[`docs/deployment-boundary.md`](docs/deployment-boundary.md).

## Context hierarchy

1. `AGENTS.md` classifies the task and routes to an owner.
2. A development or operational skill supplies the procedure and authority
   boundary.
3. Canonical domain docs explain current contracts; plans and dated evidence
   preserve scoped design or observations.
4. Code, schemas, configuration, and generated OpenAPI define current behavior.
5. Tests and protected checks prove internal contracts; runner smoke evidence,
   deployment identity, logs, and console journeys prove wider claims.

When two surfaces own the same current fact, move the fact to the smallest
semantic owner and leave links elsewhere. Do not add synchronization machinery
to preserve documentation duplication.

## Authority and proof

Authentication, capability, and authorization are separate. A valid principal
receives only the scopes and pipelines declared by the Work grants. A worker's
repository token, telemetry writer, QueueExecutor credential, maintainer
session, Terraform executor, and deployment identity are intentionally
different authorities.

Proof follows the claim:

| Claim                     | Minimum relevant evidence                                          |
| ------------------------- | ------------------------------------------------------------------ |
| Orchestrator transition   | Decision/model test plus durable-store behavior                    |
| Work API contract         | Contract/OpenAPI test and authenticated handler behavior           |
| Console journey           | Production build and selected hermetic E2E                         |
| Published fleet interface | Publisher contract plus representative consumer                    |
| Runner/runtime behavior   | Image or bootstrap contract and controlled smoke evidence          |
| Live deployment           | Exact revision identity, rollout health, and relevant logs/journey |

## Harness design

The repository harness uses a compact root map, prompt-triggered skills,
domain-owned documentation, executable contracts, explicit authority, and
outcome-matched proof. This direction is informed by Ryan Lopopolo's
[Harness Engineering](https://github.com/lopopolo/harness-engineering) field
guide and adapted to Agent LCARS's existing control-plane and fleet contracts.
