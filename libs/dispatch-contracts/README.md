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

## Why it is plain JavaScript

`.github/actions/dispatch-broker` runs under bare `node` with no build step
(`ci.yml` runs `node --test .github/actions/dispatch-broker/*.test.mjs`). A
TypeScript source could not be a shared definition for it — only a re-derived
copy, which is the thing this package exists to retire.

So the source is plain ESM JavaScript and the types come from JSDoc, checked
by `checkJs`. TypeScript consumers get full inference from the same file the
broker executes:

```ts
// apps/console — resolved through the tsconfig path alias
import { PIPELINE_CONTRACTS } from '@agent-lcars/dispatch-contracts';
```

```js
// .github/actions/dispatch-broker — resolved relative to the repo root
import { PIPELINE_CONTRACTS } from '../../../libs/dispatch-contracts/src/index.js';
```

The relative form is a sanctioned pattern: a cross-repo `uses:` downloads the
whole repository, and any action relying on a path above its own directory
says so in its `action.yml` — see
[docs/published-actions.md](../../docs/published-actions.md)'s "whole-repo-download
caveat".

This package must keep **zero dependencies**, including node builtins. The
console imports it from `watched-repo.ts`, which is deliberately client-safe;
one server-only import would break a `'use client'` bundle.

## What cannot import it

GitHub Actions YAML and repo variables cannot import JavaScript. Two things
are therefore pinned by contract test instead of by import, and both must be
edited alongside this package:

- the four worker workflows' `run-name:` and per-lane `env:` values —
  `.github/actions/dispatch-broker/workflow-contract.test.mjs` derives every
  expected value from this registry;
- the `AGENT_BOT_LOGINS` repo variable that `agent-automerge.yml` reads, which
  must equal this package's `AGENT_BOT_LOGINS`.

## Adding a pipeline

Add one entry to `PIPELINE_CONTRACTS` in `src/pipelines.js`, then add the
worker workflow itself and update the `AGENT_BOT_LOGINS` repo variable if the
new pipeline pushes under a login no existing pipeline uses. Everything else —
labels, reply commands, reconcile discovery, deliverable author exclusion,
console integrations — derives.
