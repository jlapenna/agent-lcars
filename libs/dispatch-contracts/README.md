# @agent-lcars/dispatch-contracts

The single published definition of the facts more than one of
[#645](https://github.com/jlapenna/agent-lcars/issues/645)'s five systems has
to agree on.

## Why this exists

Nine formats were each kept as an independent hand-copy in two or more
systems, synced only by a code comment or by a regex contract test written
after an incident — never by an actual shared import. Adding a pipeline meant
five correct edits in five files, or it would be recognized in some systems
and invisible in others.

This package is where those definitions live now. **Import it; do not
re-derive it.**

Covered today (reviewed against `e4b1baa`, 2026-10-09):

| Contract                                                  | Current owner and consumers                                                                              |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Pipeline identity, labels, reply commands, and bot logins | `src/pipelines.ts`; console intake, admission, activity, and runner integration derive from the registry |
| Dispatch marker and exact attempt claim                   | `src/marker.ts`; dispatch identity and deliverable verification                                          |
| Outcome and Quick Task formats                            | `src/outcomes.ts` and `src/quick-task.ts`; shared completion and request-binding consumers               |

[`pipelines.spec.ts`](src/pipelines.spec.ts) and
[`marker.spec.ts`](src/marker.spec.ts) protect the registry and marker formats.
Historical broker and worker-workflow copies are retired, not current consumers.

`recovery-observation.ts` (the `recovery/v1:<domain>:...` operation-key
contract) was removed in #1015 Wave 4: its only consumer,
`apps/console/src/lib/hosted-recovery-observation.ts`, was deleted along
with the console ingestion endpoint it backed (no workflow in this repo or
a consumer repo ever gained trust to call it — see #870). `pr-heal.yml`'s
`pr-heal-ledger:v1` comment and `post-deploy-verify.yml`'s
`post-deploy-verify-dispatch:<sha>` marker in
`supersprinklesracing/sprinkles` remain their own independently-invented
idempotency keys (see [#864](https://github.com/jlapenna/agent-lcars/issues/864));
sharing a contract for them is unbuilt, not landed here.

The provider-neutral Lifecycle Control Plane v1 boundary that used to live
under `src/control-plane/` was deleted with the lifecycle control plane
itself (#1171); [`libs/orchestrator`](../orchestrator) owns admission now.

## Why it has zero dependencies

This package is TypeScript now — `.github/actions/dispatch-broker`'s old
bare-`node`-with-no-build-step constraint, which once forced a plain-JS +
JSDoc source so a real TypeScript file could not be a shared definition for
it, is gone (as is the broker itself, deleted in #1199). Consumers import
it through the tsconfig path alias:

```ts
// e.g. apps/console's watched-repo.ts — resolved through the tsconfig
// path alias
import { pipelineContract } from '@agent-lcars/dispatch-contracts';

const contract = pipelineContract('claude');
```

What survives that change is the reason this package must keep **zero
dependencies**, including node builtins. The console imports it from
`watched-repo.ts`, which is deliberately client-safe; one server-only import
would break a `'use client'` bundle.

## Published interfaces and configuration

Member repositories consume the [published actions and reusable workflows](../../docs/published-actions.md),
shared [worker protocol](../../agents/shared/skills/agent-protocol/reference/agent-protocol.md),
and runner image. They do not import this repository's source. GitHub-anchor
intake uses the Work API; its [generated OpenAPI contract](../../docs/api/work-v1.openapi.json)
owns the dispatch payload and response.

GitHub Actions YAML and repository variables cannot import TypeScript. The
`AGENT_BOT_LOGINS` repository variable used by auto-merge must match this
package's exported bot logins. Registry unit tests pin the expected identities;
they do **not** read or validate the live repository variable. The old
`pipelines.contract.test.mjs` reference is not a current check.

Hosted provider worker workflows and their `run-name:`/per-lane `env:` copies
are retired; providers execute via QueueExecutor and the direct runner.
[#1298](https://github.com/jlapenna/agent-lcars/issues/1298) is closed and
must not be used as an outstanding requirement to restore deleted workers.
Supported action input/output contracts are checked by
`published-actions.contract.test.mjs` as documented by the published-interface
policy; reusable
workflow manifests and actionlint own their YAML surfaces. See the
[published-interface verification policy](../../docs/published-actions.md#contract-verification).

## Adding a pipeline

Add an entry to `PIPELINE_CONTRACTS` in `src/pipelines.ts`, update its public
`AgentPipeline` type and registry tests, and implement provider execution and
telemetry support in the direct runner. Update `AGENT_BOT_LOGINS` configuration
if the pipeline uses a new login, through its authorized configuration owner.
Labels, reply commands, discovery, author exclusion, and console integrations
derive from the registry. Do not add a hosted worker workflow.
