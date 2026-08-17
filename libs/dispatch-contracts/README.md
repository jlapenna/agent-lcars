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

Covered today:

| Contract                               | Previously hand-copied in                                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pipeline identity registry             | `normalize.mjs`, `github-api.mjs` (twice), `broker.mjs`, console `watched-repo.ts`, console `action-items.ts`, and the four worker workflows' `env:` blocks |
| Dispatch marker `[dispatch:g<n>:<id>]` | `main.mjs`, `github-api.mjs`, console `agent-activity.ts`, and four `run-name:` YAML strings                                                                |

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

## What cannot import it

GitHub Actions YAML and repo variables cannot import JavaScript. Two things
must therefore be edited alongside this package by hand:

- the three worker workflows' `run-name:` and per-lane `env:` values —
  formerly pinned by `apps/dispatch-broker/src/workflow-contract.spec.ts`,
  deleted with the broker in #1199; #1298 tracks restoring that derivation
  as a standalone contract test;
- the `AGENT_BOT_LOGINS` repo variable that `agent-automerge.yml` reads, which
  must equal this package's `AGENT_BOT_LOGINS`.

## Adding a pipeline

Add one entry to `PIPELINE_CONTRACTS` in `src/pipelines.ts`, then add the
worker workflow itself and update the `AGENT_BOT_LOGINS` repo variable if the
new pipeline pushes under a login no existing pipeline uses. Everything else —
labels, reply commands, reconcile discovery, deliverable author exclusion,
console integrations — derives.
