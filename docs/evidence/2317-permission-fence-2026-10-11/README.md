# Inbox permission fence source qualification

Issue #2317, 2026-10-11. Base: `6fea1863db91a4f6512d410c26c273b80b6af411`.
The production candidate fence already arrived through PR #2323. This change
extends the actual component's regression probes; it adds no production behavior.
The required CI Verify job consumes these component and source tests.

The component runs in the normal Console Vitest/jsdom harness with mocked
current authenticated snapshots, browser locks and service-worker OS delivery.
It is not a live browser, real Work-grant revocation or physical OS display test.

## Negative control

In the owned feature worktree, replace only the component's candidate expression:

```diff
- const candidates = state.pending.filter(
-   (d) => authorized.get(d.id) === d.generation,
- );
+ const candidates = state.pending;
```

Run `pnpm exec vitest run --config apps/console/vitest.config.mts
src/app/inbox-notifications.test.tsx --maxWorkers=1 --no-passWithNoTests`.
The preserved `without-fence.log` records exit 1, 4 failed and 22 passed tests.
Both equal and 1-second-older watermarks allow an omitted native pending item
to request `Agent LCARS` with `/inbox?item=work%3A01ABC`. With a different
currently authorized generation at that id, the old pending generation wrongly
joins the GitHub handoff and changes its link to `/inbox`.

This is a bounded mutation of current source, not a historical-source replay.
The component was restored in a `finally` block and its diff against base is empty.

## Restored source

Run `pnpm exec vitest run --config apps/console/vitest.config.mts
src/app/inbox-notifications.test.tsx src/lib/inbox-notifications.test.ts
src/lib/inbox-notifications-data.test.ts src/lib/inbox-notifications-client.test.ts
src/app/api/inbox-notifications/route.test.ts --maxWorkers=1 --no-passWithNoTests`.
The preserved `current-source.log` records exit 0 and 49 passed tests in 5 files.

The added probes observe no worker lookup or OS request for omitted native
pending decisions at equal/older clocks. Mixed pending candidates deliver only
the currently authorized GitHub generation. Retained history and source clocks
remain monotonic; suppressed native generations remain pending, and only a
permitted display request consumes the send time. Account mismatch, unavailable
sources, stale observation, each stale source clock and denied browser permission
suppress retained pending work without consuming an attempt. Existing probes
cover newly authorized native generations, rate limits and cross-tab deduplication.

Production component SHA-256:
`bbf2e2a724ca1ce201250b79b5936606bec47e89054cc8271f496f0a61435cee`.
Test overlay SHA-256:
`ae9cea47592bc7fdbfc89998c7f544309297c24748672f343b30ada81508c771`.

Protected PR delivery, rendered browser qualification and deployed/runtime
acceptance are separate gates. These logs establish source regression evidence
only; they do not close those remaining acceptance gates.
