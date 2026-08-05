# Verify — Definition of Done

The full gate — this is what `.github/workflows/ci.yml`'s `Verify` job
(a required check gating every merge) authoritatively runs on its own
GitHub-hosted runner:

```bash
pnpm check:dependencies    # lockfile / workspace-mandate integrity
pnpm format:check          # prettier, nx format:check --all
pnpm lint                  # nx run-many -t lint --all
pnpm lint:circular          # madge circular-dependency check
pnpm exec nx run-many -t test typecheck build --all
```

Or run the composite `pnpm verify`, which chains the above (minus
`check:dependencies`).

## CI delegation

Don't run the full gate above locally before every push — see "Push early"
in [SKILL.md](../SKILL.md#hard-guardrails). The pre-push hook only runs the
fast slice (`format:check`, affected `lint`/`typecheck`); `test` and
`build` — the two steps that scan/compile the whole affected set and take
the longest — are deliberately left out, because CI's `Verify` job re-runs
them anyway the moment you push, on its own runner rather than your
workstation. The gate still runs exactly once as far as the merge
requirement is concerned; running it a second time locally first only adds
a serialized wait in front of a check that was going to happen regardless.

Run the full local gate only when you have a specific reason not to trust
CI's answer for it — e.g. iterating on a change to the Nx config or task
graph itself, where you want to see the affected-project computation
directly. Otherwise: fast layer locally, push, let CI's `Verify` job carry
the rest.

## Console e2e

`pnpm verify` does **not** run the console e2e suite. When a change touches
anything the dashboard renders or fetches — `apps/console/src/lib`, a Server
Action, the e2e GitHub fixture — run it too:

```bash
pnpm exec nx run @agent-lcars/console-e2e:e2e-local
```

### RSC client/server boundary traps

`apps/console` is a Next.js App Router app: scoped vitest + typecheck are
structurally blind to bugs at the server/client component boundary. Four
distinct traps shipped past both in one night (retro #521) and were only
caught by the hermetic e2e suite or CI's prerender step, each with a
multi-minute feedback loop:

1. **Component-as-prop across the boundary.** Passing a component
   reference as a prop from a server component into a client component's
   polymorphic prop (e.g. Mantine's `component={SomeComponent}`) fails at
   render with "Functions cannot be passed directly to Client Components."
2. **A `'use client'` module value-importing a server-deps module.**
   Drags Node-only dependencies (firebase-admin, google-auth-library, ...)
   into the browser bundle and fails the build with dozens of Turbopack
   resolve errors (the #59 failure mode). `import type` is always safe.
   Reusable Console modules that touch secrets, data stores, or Node-only
   dependencies start with `import 'server-only';`. That framework-native
   marker is the authoritative transitive build guard. The
   `@nx/workspace-no-server-only-imports-in-client` rule
   (`tools/eslint-rules/rules/no-server-only-imports-in-client.ts`) derives
   its package and local-module coverage from Nx `platform:server` tags plus
   the actual `server-only`/`assertNotBrowser()` markers, and catches direct
   imports in the editor without a second hand-maintained denylist.
3. **Server code calling a function exported from a client module.**
   Fails at runtime with "Attempted to call X() from the server."
4. **Cross-page `next/link` transitions leaving the previous page's DOM
   mounted** (#503) — a pure client-side/browser bug; nothing short of a
   real browser catches this one.

None of these are reliably caught by unit tests or typecheck (#537). Treat
any change that adds/removes a `'use client'` directive, moves a component
across the server/client line, or touches `apps/console/src/app`'s
navigation/layout as boundary-adjacent, and run `console-e2e:e2e-local`
(above) before pushing it — not just when one of the four examples above
literally recurs, but as a standing habit for anything boundary-shaped.

Use `'use server'` only for exported Server Functions/Actions; it is not a
general replacement for `server-only`. Vitest aliases `server-only` to a
shared no-op fixture so plain Node/Vite unit tests can import server modules;
the production Next build does not use that alias and still fails if a marked
module enters the client graph.

An `apps/console`-affected push also gets a fast production `next build`
smoke in the pre-push hook (`tools/console-build-smoke.sh`), which catches
class 1 and prerenderable cases of class 3 in well under a minute. It is
not a substitute for `e2e-local`: a build can't see anything that only
breaks at request time on a non-prerendered route or in a real browser
(class 4 stays e2e-only until #503 is understood).

Use that target, not `:e2e` directly. It sets up the same environment CI's
"Prepare E2E environment" step does (materializing `.env.e2e` from
`tools/e2e/ci.env` without clobbering a customized one, and exporting the
`NEXT_PUBLIC_*`/`AUTH_SECRET` values that must exist _before_ the
`dependsOn` build inlines them). Run bare, `:e2e` fails on a fresh checkout
with `AGENT_LCARS_GITHUB_TOKEN not defined`, which names neither cause.

It also passes `--skip-nx-cache`, deliberately: an e2e result replayed from
the Nx cache reports a green suite that never ran, which is worse than
useless when the suite is the thing you are trying to trust. For screenshot
work use `:e2e-docker` instead, which pins the rendering environment.

To scope a run, drive Playwright directly — `:e2e` sets
`forwardAllArgs: false`, so trailing args passed to it are silently dropped
and the whole suite runs anyway:

```bash
pnpm exec nx run @agent-lcars/console-e2e:e2e-run --grep @smoke
```
