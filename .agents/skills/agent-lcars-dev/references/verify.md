# Verify — Definition of Done

The full gate — this is what `.github/workflows/ci.yml`'s `Verify` job
(a required check gating every merge) authoritatively runs on its own
configured runner (`lcars-ci` for trusted work, GitHub-hosted for fork PRs):

```bash
pnpm check:dependencies    # lockfile / workspace-mandate integrity
pnpm format:check          # prettier, nx format:check --all
pnpm lint                  # nx run-many -t lint --all
pnpm lint:circular          # madge circular-dependency check
./tools/nx run-many -t test typecheck build test-race --all
```

The composite `pnpm verify` runs formatting, lint, circular-dependency checks,
tests, typecheck, and build. It does not include `check:dependencies`,
`test-race`, or the workflow's Terraform/tooling checks; do not call it the
complete CI gate. Consult `.github/workflows/ci.yml` for those additional
boundaries and use CI delegation below.

## CI delegation

For a failed or stalled publication, use
[delivery-recovery.md](delivery-recovery.md) to distinguish transport, hook and
ambiguous-response failures before retrying. A transport error does not waive
any verification gate below.

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

## Frozen Console test reviews

Use a separate, normally installed Git worktree at the exact reviewed commit
for immutable Console test evidence. A relocated `git archive` with
`node_modules` symlinked to another checkout is not an equivalent harness:
shared setup can resolve outside the archive root and fail collection with a
literal Vite `/@fs/` module identifier even when the underlying file exists.
That failure executes zero tests; it is not evidence of a missing dependency
or a failing HTTP contract. Do not repair it by disabling setup, copying shared
helpers or inventing another Vitest configuration.

1. Record the full reviewed SHA and check live ownership. Follow the
   [worktree guardrails](../SKILL.md#hard-guardrails) to create an exclusively
   owned review worktree and unique local branch at that SHA. Keep application
   changes in their separate feature worktree; do not switch or reinstall
   another owner's checkout.
2. Install the reviewed revision's frozen lockfile without running its
   lifecycle scripts:

   ```bash
   pnpm install --frozen-lockfile --ignore-scripts
   bash tools/setup-nx-native-file-cache.sh
   ```

   Do not run `setup-worktree.sh`, `setup-git-hooks.sh` or the workspace
   `prepare` script from the frozen review. Git stores the Husky bootstrap
   and hook path in the shared common directory; an older reviewed installer
   can replace that policy for every active sibling worktree. Record the
   configured hook path and shared bootstrap hashes before and after the
   install and require them to remain unchanged. Existing commit/push hooks
   stay enabled; author feature worktrees still use normal worktree setup.
   Retain the normal project config and shared test setup. If an ignored
   dependency build script is required by the selected tests, treat that as
   an explicit setup gate rather than running the reviewed workspace lifecycle
   or changing shared hooks.

3. Bind evidence to source before and after testing: require `git rev-parse
HEAD` to equal the reviewed SHA and `git diff --exit-code <reviewed-sha> --
.` to pass. Inspect untracked files; record hashes and the explicit scope
   of any independent test overlays separately from unchanged production,
   owning tests, setup, configuration and lockfile bytes.
4. Run the selected owning tests directly, without an Nx result-cache replay.
   From the review worktree root, for example:

   ```bash
   pnpm exec vitest run --config apps/console/vitest.config.mts \
     src/lib/runs-router.test.ts --maxWorkers=1 --no-passWithNoTests
   ```

   Select the actual file needed for the review. Retain the command, cwd,
   true exit status, complete log and executed test count. Preserve earlier
   zero-test collection failures separately from a successful rerun; do not
   replace their receipt with the new result.

5. When proving a regression boundary, apply a bounded negative mutation only
   in an owned isolated fixture, retain its diff and assertion failure, then
   restore and recheck the frozen source. A setup/collection failure is not a
   successful negative control. A run in an existing owning checkout can be
   additional evidence only when its source is byte-bound to the reviewed
   revision and using it respects that checkout's live ownership.

This procedure establishes scoped test evidence, not browser acceptance,
ready-event CI, protected delivery or deployed functionality. Keep deeper
tooling attribution uncertain until traced; a successful supported worktree
does not identify an upstream Vite defect.

## Console e2e

`pnpm verify` does **not** run the console E2E suite locally. CI has the
required E2E check: it selects affected console and harness changes and runs
the hermetic suite. Local E2E is optional diagnostic evidence for reproducing
or iterating on a browser failure; it is not required before pushing or part
of deliverable proof.

When a local reproduction is useful, use the same hermetic entrypoint as CI:

```bash
./tools/nx run @agent-lcars/console-e2e:e2e-local
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
   `fleet/no-server-only-imports-in-client` rule from
   `@jlapenna/repo-tools/eslint` derives its package and local-module coverage
   from Nx `platform:server` tags plus the actual
   `server-only`/`assertNotBrowser()` markers, and catches direct imports in
   the editor without a second hand-maintained denylist.
3. **Server code calling a function exported from a client module.**
   Fails at runtime with "Attempted to call X() from the server."
4. **Cross-page `next/link` transitions leaving the previous page's DOM
   mounted** (#503) — a pure client-side/browser bug; nothing short of a
   real browser catches this one.

None of these are reliably caught by unit tests or typecheck (#537). Treat
any change that adds/removes a `'use client'` directive, moves a component
across the server/client line, or touches `apps/console/src/app`'s
navigation/layout as boundary-adjacent. CI will run the browser gate for that
change; run `console-e2e:e2e-local` (above) locally only when debugging or
reproducing a boundary failure.

Use `'use server'` only for exported Server Functions/Actions; it is not a
general replacement for `server-only`. Vitest aliases `server-only` to a
shared no-op fixture so plain Node/Vite unit tests can import server modules;
the production Next build does not use that alias and still fails if a marked
module enters the client graph.

An `apps/console`-affected push also gets a fast production `next build`
smoke in the pre-push hook (`tools/console-build-smoke.sh`), which catches
class 1 and prerenderable cases of class 3 in well under a minute. It is
not a substitute for CI's E2E gate: a build can't see anything that only
breaks at request time on a non-prerendered route or in a real browser
(class 4 stays browser-e2e-only until #503 is understood). Local E2E remains
available for focused diagnosis, but is not required to deliver the change.

Use that target, not `:e2e` directly. It sets up the same environment CI's
"Prepare E2E environment" step does (materializing `.env.e2e` from
`tools/e2e/ci.env` without clobbering a customized one, and exporting the
`NEXT_PUBLIC_*`/`AUTH_SECRET` values that must exist _before_ the
`dependsOn` build inlines them). Run bare, `:e2e` fails on a fresh checkout
with a "not defined" error for whichever required env var the server reads
first, which names neither cause.

It also passes `--skip-nx-cache`, deliberately: an e2e result replayed from
the Nx cache reports a green suite that never ran, which is worse than
useless when the suite is the thing you are trying to trust. Use
`:e2e-docker` when reproducing a browser/runtime-specific CI failure in the
pinned runner environment. Screenshots are retained as failure diagnostics;
they are not committed pixel-equality gates. The repository-wide contract and
failure-triage checklist live in
[`docs/e2e-reliability.md`](../../../../docs/e2e-reliability.md).

To scope a run, drive Playwright directly — `:e2e` sets
`forwardAllArgs: false`, so trailing args passed to it are silently dropped
and the whole suite runs anyway:

```bash
./tools/nx run @agent-lcars/console-e2e:e2e-run --grep @smoke
```
