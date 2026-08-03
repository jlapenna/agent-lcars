# Verify — Definition of Done

Before ending your turn with a PR open (or updated):

```bash
pnpm check:dependencies    # lockfile / workspace-mandate integrity
pnpm format:check          # prettier, nx format:check --all
pnpm lint                  # nx run-many -t lint --all
pnpm lint:circular          # madge circular-dependency check
pnpm exec nx run-many -t test typecheck build --all
```

Or run the composite `pnpm verify`, which chains the above (minus
`check:dependencies`). These are the same checks CI runs in
`.github/workflows/ci.yml` — match them locally before pushing so your own
push doesn't just trade a slow feedback loop for CI's.

## Console e2e

`pnpm verify` does **not** run the console e2e suite. When a change touches
anything the dashboard renders or fetches — `apps/console/src/lib`, a Server
Action, the e2e GitHub fixture — run it too:

```bash
pnpm exec nx run @agent-lcars/console-e2e:e2e-local
```

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
