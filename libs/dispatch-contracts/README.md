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

| Contract                                            | Previously hand-copied in                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pipeline identity registry                          | `normalize.mjs`, `github-api.mjs` (twice), `broker.mjs`, console `watched-repo.ts`, console `action-items.ts`, and the four worker workflows' `env:` blocks                                                                                                                                                |
| Dispatch marker `[dispatch:g<n>:<id>]`              | `main.mjs`, `github-api.mjs`, console `agent-activity.ts`, and four `run-name:` YAML strings                                                                                                                                                                                                               |
| Recovery operation key (`recovery/v1:<domain>:...`) | Never shared before — `pr-heal.yml`'s `pr-heal-ledger:v1` comment and `post-deploy-verify.yml`'s `post-deploy-verify-dispatch:<sha>` marker in `supersprinklesracing/sprinkles` each independently invented an equivalent idempotency key (see [#864](https://github.com/jlapenna/agent-lcars/issues/864)) |

## Why it has zero dependencies

This package is TypeScript now — `.github/actions/dispatch-broker`'s old
bare-`node`-with-no-build-step constraint, which once forced a plain-JS +
JSDoc source so a real TypeScript file could not be a shared definition for
it, is gone. The broker is `apps/dispatch-broker`, an Nx app bundled by
esbuild before it ever runs, and it imports this package the same way any
other consumer does:

```ts
// apps/console and apps/dispatch-broker — resolved through the tsconfig
// path alias
import { PIPELINE_CONTRACTS } from '@agent-lcars/dispatch-contracts';
```

What survives that change is the reason this package must keep **zero
dependencies**, including node builtins. The console imports it from
`watched-repo.ts`, which is deliberately client-safe; one server-only import
would break a `'use client'` bundle.

## What cannot import it

GitHub Actions YAML and repo variables cannot import JavaScript. Two things
are therefore pinned by contract test instead of by import, and both must be
edited alongside this package:

- the four worker workflows' `run-name:` and per-lane `env:` values —
  `apps/dispatch-broker/src/workflow-contract.spec.ts` derives every
  expected value from this registry;
- the `AGENT_BOT_LOGINS` repo variable that `agent-automerge.yml` reads, which
  must equal this package's `AGENT_BOT_LOGINS`.

## Adding a pipeline

Add one entry to `PIPELINE_CONTRACTS` in `src/pipelines.ts`, then add the
worker workflow itself and update the `AGENT_BOT_LOGINS` repo variable if the
new pipeline pushes under a login no existing pipeline uses. Everything else —
labels, reply commands, reconcile discovery, deliverable author exclusion,
console integrations — derives.
