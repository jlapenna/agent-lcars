# Agent LCARS product spec

This product specification comes in two parts:

1. [The console](console-product-spec.md): the maintainer-facing control
   surface. It covers information architecture, each destination (`Bridge`,
   `Inbox`, `Agents`, `Shuttlebay`, `Work`, `Jobs`, `Sessions`, `Costs`, plus
   `Settings`, `Job Credentials`, and `Issue Sources`), auth, live data, Web
   Push notifications, the visual system, the companion `lcars` CLI, and the
   frontend roadmap.
2. [Fleet management and orchestration](fleet-orchestration-product-spec.md):
   GitHub and Linear intake, event-driven issue triage, the task/run state
   machine, admission and queueing, repository-owned Goose jobs, per-job
   credential sets, direct-runner execution (`claude`, `codex`, `opencode`,
   `agy`, `goose`), the worker contract, ready deliverable ownership and merge,
   telemetry, fleet boundaries, and the control-plane roadmap.

## Harness engineering principles

Following the repository's [harness design](../../ARCHITECTURE.md#harness-design):

- **One semantic owner per fact.** Both parts summarize the product and route
  to canonical owners (Zod schemas in `libs/*`, generated OpenAPI contracts,
  domain documents in `docs/`, and executable contract tests in
  `tools/contract-tests/`). Do not turn this directory into a parallel runbook.
- **Status vocabulary.** Requirements are marked `[Shipped]`, `[Implemented]`,
  `[Partial]`, or `[Proposed]`, separating source implementation from hermetic
  E2E and live production qualification.
- **Outcome-matched proof.** Every surface names the verification boundary that
  proves it works (unit/contract test, hermetic Playwright E2E, runner image
  smoke, or live production qualification).
- **Explicit authority.** Operator session auth, scoped `AGENT_LCARS_WORK_GRANTS`,
  run-scoped claim tokens, GitHub Actions OIDC, and GCP Secret Manager job
  grants remain distinct trust boundaries.

Both parts describe the shipped product as of the commit named in their
headers. Code, generated contracts, and the canonical documents linked from
each part remain authoritative. When they disagree with a spec, correct the
spec.
