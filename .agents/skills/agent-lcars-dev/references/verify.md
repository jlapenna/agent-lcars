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
