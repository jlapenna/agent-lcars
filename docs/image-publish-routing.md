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

## Job graph: one job, not one per image

`publish-images.yml` is a single job (`publish`). The plan step runs first;
every later step -- the whole-workspace test gate, the bundle smoke-test,
and each image's own build/scan/promote steps -- has its own `if:` reading
`steps.plan.outputs.*` directly, so a push that needs nothing built skips
every step after the plan (and a control-plane-only push skips the bundle
smoke-test and both other images' build/scan/promote steps, etc.).

This was **not** the first design. A now-reverted version split
`control-plane`/`jit-runner`/`watcher` into separate GitHub Actions jobs
(`plan -> verify-workspace -> {control-plane, jit-runner, watcher}` in
parallel), reasoning that independent images could build concurrently. Real
production testing (agent-lcars#441's PR discussion) showed this was wrong
for two compounding reasons:

1. **`lcars-build-client` is capped at `max_runners: 1`, by design.**
   jlapenna/homelab's orchestrator config comments this exact scale set:
   "image publishing is serialized by the registry anyway, and one holder
   of the push credential at a time is the point." Three dependency-free
   jobs on that label can never actually run concurrently -- only one
   runner of that label is ever online.
2. **Splitting into jobs multiplies the per-job runner-provisioning cost.**
   A real `workflow_dispatch` run of the 5-job version
   ([run 30869868020](https://github.com/jlapenna/agent-lcars/actions/runs/30869868020))
   took **52m09s** wall-clock -- slower than the original single-job
   baseline -- even though the three images' actual build times were each
   fast (2m16s, 1m34s, 3m12s -- a warm registry cache). The gap was
   overhead: ~26 minutes queued before `plan` even started, then another
   ~16 minutes between `verify-workspace` finishing and `control-plane`
   starting. Every job boundary under a capacity-1 pool appears to pay its
   own ephemeral-runner cold-start cost, serially -- a cost the original
   single-job design only ever paid once.

Given (1), job-level parallelism bought nothing this pool could ever use;
given (2), it actively cost more on the very case (rebuilding everything)
the split was supposed to leave no worse off. Step-level `if:` gates inside
one job get the same "skip unrelated image work" benefit -- the actual
point of agent-lcars#441 -- without either problem, at the cost of never
attempting real concurrency (which, per (1), was never available anyway).

## Recorded run durations

| Scenario                                                       | Before (serial, single job, no routing)                                                                                                  | After (single job, step-level routing)                                                                                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Representative full run (all three images legitimately change) | 20m02s ([run 30863366962](https://github.com/jlapenna/agent-lcars/actions/runs/30863366962))                                             | _to record: first post-merge push (or forced dispatch) against the single-job design -- expect close to the original baseline_                                                     |
| Watcher deployment-config-only (#440)                          | 19m57s wall-clock (~17m44s queued), no image built ([run 30864786750](https://github.com/jlapenna/agent-lcars/actions/runs/30864786750)) | No workflow run created (excluded by the `on.push.paths` negation) -- 0 builder capacity consumed                                                                                  |
| Bundle-input-only change (watcher app source or a shared lib)  | ~20m02s (same as the full run -- no routing existed)                                                                                     | _to record: first post-merge push touching only bundle inputs -- expect the workspace gate + bundle smoke-test + two image steps_                                                  |
| Full rebuild, split into 5 jobs (reverted design)              | n/a                                                                                                                                      | 52m09s ([run 30869868020](https://github.com/jlapenna/agent-lcars/actions/runs/30869868020)) -- see "Job graph" above for why this was slower, not faster, and why it was reverted |

The "before" rows and the reverted-design row are concrete evidence already
gathered. The remaining "after" rows can only be measured from real runs of
the single-job design once it lands on `main` -- update this table from the
Actions run list the first time each scenario actually occurs.
