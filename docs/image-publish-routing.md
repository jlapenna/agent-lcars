# Which image builds when: `publish-images.yml`'s path-based routing

`publish-images.yml` publishes three different images from this one repo.
Building all three serially on every push — including ones that only touch
one of them, or touch none of them at all — is what made a
deployment-config-only telemetry-watcher change (#440) spend ~20 minutes of
builder capacity on a run that built nothing. This document is the map:
which image's inputs are which, the one invariant that must never drift, and
the routing tests that enforce it. See #441 for the original report and
`.github/actions/plan-image-publish/plan.mjs` for the actual routing code —
this document explains it, that file is the source of truth.

## The three images

| Image                           | Build context                         | Dockerfile                                       | Consumer                                      |
| ------------------------------- | ------------------------------------- | ------------------------------------------------ | --------------------------------------------- |
| `agent-lcars/runner-autoscaler` | `apps/runner-autoscaler`              | `apps/runner-autoscaler/Dockerfile`              | homelab's autoscaler control-plane deployment |
| `homelab-runner:jit-node24`     | `apps/runner-autoscaler/runner-image` | `apps/runner-autoscaler/runner-image/Dockerfile` | every self-hosted CI job in this fleet        |
| `agent-lcars/telemetry-watcher` | repo root (`.`)                       | `apps/telemetry-watcher/Dockerfile`              | pike, the per-workstation telemetry daemon    |

The JIT runner image and the telemetry-watcher image are **different
artifacts built from the same source**: both bake in
`nx bundle @agent-lcars/telemetry-watcher`'s output (see that Dockerfile's
own comments). The control-plane image is a self-contained Go build with no
dependency on the Node/pnpm workspace at all.

## Routing rules

Each pushed file is classified by `plan.mjs`, in this priority order:

1. **Workflow infrastructure** — `.github/workflows/publish-images.yml`,
   `.github/actions/scan-image/**`, `.github/actions/plan-image-publish/**`.
   Schedules **all three** images. Changing how an image is built, scanned,
   or routed is as much a reason to republish-and-exercise as changing what's
   in it (the same reasoning `scan-image` already applied, #224).
2. **Bundle inputs** — `apps/telemetry-watcher/**` (except the two
   exclusions below), plus `libs/telemetry/**`, `libs/logging/**`,
   `libs/env-vars/**`, `libs/util/**`, `libs/util-server/**`, `package.json`,
   `pnpm-lock.yaml`, `patches/**`. Schedules **both** the JIT runner and the
   watcher (never the control plane, which doesn't depend on any of these).
   See "The shared bundle invariant" below — the watcher app's own source is
   in this bucket too, not a separate "watcher-only" one, because both
   images bundle it identically.
3. **JIT runner image inputs** — `apps/runner-autoscaler/runner-image/**`.
   Schedules only the JIT runner.
4. **Control-plane inputs** — everything else under
   `apps/runner-autoscaler/**`. Schedules only the control plane.
5. Everything else (`apps/console/**`, `docs/**`, …) schedules nothing.

A push can match more than one rule; each image is scheduled if **any**
matching rule schedules it — there is no "first match wins" short-circuit
across images, only within a single image's own inputs.

## The shared bundle invariant

A change to the telemetry-watcher bundle's inputs — its own app source, or
anything it inlines — must schedule the JIT runner and watcher builds
**together, every time** — never one without the other. Left to drift, one
image would keep shipping the daemon bundle without the other's fix or
dependency bump, silently, until some unrelated change happened to trigger
the missed one (see #29 and #52 for the two prior incidents this exact
failure mode already caused, and the PR #443 review discussion for a third:
an early version of `plan.mjs` treated `apps/telemetry-watcher/src/**` as
watcher-only, which would have left the JIT runner on a stale bundle after
every plain watcher-app source change).

`plan.mjs` protects this by reading both routes from **one** function
(`isBundleInput`) rather than maintaining a separate "runner telemetry
inputs" and "watcher telemetry inputs" list that could diverge.
`plan.test.mjs` asserts every bundle input schedules both images and never
the control plane.

## What never triggers a build

`apps/telemetry-watcher/deploy/**` (the standalone daemon's own Docker
Compose config, `.env.example`, deploy script, and its own README) and the
app's top-level `README.md` never reach the published image — the Dockerfile
only copies `src/` output, not `deploy/`. This is a concrete regression fix:
#440 changed exactly `deploy/docker-compose.yml` and `deploy/README.md` (an
immutable image pin and a healthcheck fix) and still triggered a full
publish run that built nothing (run
[30864786750](https://github.com/jlapenna/agent-lcars/actions/runs/30864786750),
19m57s wall-clock, ~17m44s of it queued for builder capacity).

These two exclusions are also carried into `publish-images.yml`'s own
`on.push.paths` filter (via `!`-prefixed negation patterns), so a push
touching only these paths never creates a workflow run at all — not merely
one whose jobs are skipped.

Everything else under `apps/telemetry-watcher/` — `src/**`, `project.json`,
`tsconfig*`, `eslint.config.mjs`, `vitest.config.mts` — stays a trigger.
Nx's `bundle` target definition itself lives in `project.json`, so excluding
config files risks silently shipping a stale bundle; this repo's default is
to rebuild rather than risk that (the same "loud beats silent" tradeoff the
whole-workspace test gate below already makes).

## Job graph

```
plan ──▶ verify-workspace ──┬──▶ control-plane   (if plan.control-plane)
                             ├──▶ jit-runner      (if plan.jit-runner)
                             └──▶ watcher         (if plan.watcher)
```

`verify-workspace` (the whole-workspace `nx run-many -t build test typecheck
--all` gate, plus the telemetry-watcher bundle standalone-smoke-test) runs
once — it isn't specific to any one image — and only if at least one image
is scheduled. The three image jobs are otherwise independent: no job needs
another, so they run in parallel subject to the remote BuildKit builder's
own capacity. Previously all three built serially in one job; the emulated
arm64 JIT build (`jit-runner` here) was the dominant cost, so running it
concurrently with the other two is where most of the wall-clock win comes
from on a push that touches more than one image's inputs.

## Recorded run durations

| Scenario                                                                | Before (serial, single job)                                                                                                              | After (path-gated, parallel)                                                                                                                                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Representative full run (all three images legitimately change)          | 20m02s ([run 30863366962](https://github.com/jlapenna/agent-lcars/actions/runs/30863366962))                                             | _to record: first post-merge push that legitimately changes all three inputs together — expect close to `max(control-plane, jit-runner, watcher)` build time instead of their sum_ |
| Watcher deployment-config-only (#440)                                   | 19m57s wall-clock (~17m44s queued), no image built ([run 30864786750](https://github.com/jlapenna/agent-lcars/actions/runs/30864786750)) | No workflow run created (excluded by the `on.push.paths` negation) — 0 builder capacity consumed                                                                                   |
| Bundle-input-only change (watcher app source or a shared telemetry lib) | ~20m02s (same as the full run — no routing existed)                                                                                      | _to record: first post-merge push touching only bundle inputs — expect `jit-runner` and `watcher` running in parallel, no `control-plane` work_                                    |

The two "before" rows are the concrete evidence from #441 itself. The "after"
rows can only be measured from real runs once this lands on `main` — update
this table from the Actions run list the first time each scenario actually
occurs.
