# Inbox phone interaction budget

FE-NF-7 targets p95 below 2,000 ms, separately for browser-cold and browser-warm
cases. A controlled lab result is not production qualification.

## User-ready milestone

Measure a direct `/inbox?item=…` decision navigation from its browser navigation
start until the loaded decision's actual primary-action handler opens the
visible confirmation dialog. The lab cancels that confirmation: it never
approves, merges, dispatches, or writes a real Work item. Server-rendered enabled
markup alone is not readiness evidence.

The current probe waits for document load before clicking. It is therefore a
conservative journey-completion upper bound, not the earliest possible
hydration instant or the retired Lighthouse TTI metric. The same barrier must
be used in before/after comparisons. Do not remove it only from the faster run.

## Fixed lab workload and profile

Use the existing `seed-inbox` fixture: populated GitHub decision reasons,
running/finished Work and CLI-session projections, and two native parked
decisions. The selected decision is PR #9003 in the synthetic repository. This
is a representative mixed-state regression workload, not a production-size or
many-repository stress claim.

- Chromium, 390 × 844 CSS pixels, device scale 2, mobile/touch context.
- CDP CPU slowdown 4×, 150 ms requested network latency, 1.6 Mbps download,
  750 Kbps upload; software emulation, not a physical mid-range phone.
- Server process already warm, authoritative dummy data/auth still exercised.
- Cold: new context, browser HTTP cache cleared and disabled.
- Warm: new context, one untimed identical journey, then a timed identical
  navigation with HTTP cache enabled. No Next.js SPA-prefetch result is claimed.
- Interleave warm/cold cases, 30 measured navigations per case, one worker,
  no retries. Five samples are permitted only for harness smoke diagnostics.
- p95 is nearest rank: sorted values at `ceil(0.95 × n) - 1`; never pool cases.
  Thirty samples establish a lab baseline, not a tight population confidence
  interval. Record host contention and browser version when comparing runs.

## Bounded measurement

Run against an **already running, isolated hermetic production bundle** with
the checked-in `tools/e2e/ci.env` dummy environment and loopback Firebase
emulators. Build/boot through the existing E2E or isolated development setup;
do not use a dev-mode bundle, production credentials, or a live deployment.
Keep its ports distinct from other worktrees and the fixed-port E2E lane.

```sh
env -i PATH="$PATH" HOME="$HOME" \
  E2E_HERMETIC=1 PROJECT_ID=demo-no-project \
  FIRESTORE_EMULATOR_HOST=127.0.0.1:4362 \
  node tools/e2e/measure-inbox-phone.mjs \
  --origin http://localhost:4204 --samples 30 --out /tmp/inbox-phone-before.json
```

The command rejects non-loopback targets, non-demo environments, and sample
counts outside 5–60 before seeding. Each operation has a 30-second timeout and
the browser run has a 15-minute bound. It writes raw samples, resource sizes
and durations, browser/host/profile metadata, and separate summary quantiles.
A failure produces partial evidence with an error, not a passing percentile.
The output path must be new; do not overwrite a baseline. Exit 1 means an
operational/interaction failure; inspect each case's `targetMet` separately.

Record the server's exact source revision and production build command beside
the artifact. The tool's Git revision describes the invoking checkout; it does
not independently attest which revision an arbitrary running server serves.
Retain the same profile, milestone, fixture, build mode and browser version
for the after artifact. Keep build output stable during each measurement.

The maintainer owns this on-demand signal and acts on misses under #2201.
Required E2E remains the semantic interaction gate; machine-dependent lab
percentiles do not replace or weaken required merge checks.

## Production instrumentation handoff

Qualification requires opt-in/privacy-reviewed production measurements of the
same loaded-decision/hydrated-action milestone. Separate cold/warm navigation,
route, device/network class and deployed revision; report sample count, window
and percentile definition. Exclude issue bodies, question text, transcripts,
credentials, full URLs and identifiers. Do not assume console-admin auth grants
telemetry permission. Physical-device/real-network evidence and server-cold
behavior remain separate from this software-throttled, warm-server lab.

No RUM collector, new infrastructure, external notification or production
mutation is activated by this measurement tool. Keep FE-NF-7 unqualified until
the actual target and production acceptance have evidence; preserve dated
baseline/after observations in the issue and PR rather than treating them as
live policy.
