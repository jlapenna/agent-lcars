# E2E reliability policy

The console E2E suite is a merge-safety tool. Its pass/fail contract should be
limited to behavior a user depends on: navigation, visible state, interactions,
and responsive layout. Screenshots, traces, and reports remain valuable failure
diagnostics, but broad pixel equality is not a reliable proxy for those
contracts.

This policy records the findings and fixes from [#1049](https://github.com/jlapenna/agent-lcars/issues/1049),
[#1053](https://github.com/jlapenna/agent-lcars/pull/1053), and
[#1055](https://github.com/jlapenna/agent-lcars/pull/1055).

## What went wrong

The investigation sampled 100 historical E2E jobs: 87 succeeded, 10 failed,
and 3 were skipped. Most failures after visual baselines were introduced were
not user-facing regressions. They fell into four distinct classes:

1. **Product regression:** a user-observable behavior is broken. E2E should
   fail and block delivery.
2. **Test-contract failure:** the assertion covers incidental output, such as
   a relative-time label, font rasterization, an intentional style change, or a
   transitional streaming state.
3. **Harness failure:** checkout, Git LFS, cache lifetime, environment setup,
   emulator startup, or another prerequisite fails before the product is
   exercised.
4. **Gate-policy failure:** the E2E workflow is red but is not a required check,
   so the change can merge despite the apparent safety signal.

Treating every class as "refresh the baselines" hid the cause and made the
suite expensive to trust. A refresh can be correct only after a human has
confirmed that the rendered change is intentional and the assertion itself is
worth preserving.

## The contract we keep

Agent LCARS uses semantic assertions for merge-critical E2E coverage:

- assert the accessible role, label, text, URL, enabled state, or data state
  that represents the user outcome;
- assert responsive contracts directly, such as absence of horizontal
  overflow, usable controls, and the intended mobile navigation at the
  supported 320 px and 390 px widths;
- wait for the resolved application state, not a loading fallback that may
  briefly coexist with streamed content;
- capture screenshots, traces, and the HTML report on failure rather than
  committing screenshot goldens;
- run the real E2E task without replaying its result from Nx cache.

Pixel comparison is appropriate only for a small, explicitly curated visual
contract whose inputs are deterministic and whose reviewer can explain what
regression it catches that semantic assertions cannot. Such a test must freeze
time and data, eliminate or mask volatile regions, run in a pinned rendering
environment, and have an intentional review path for baseline changes. It must
not become the default assertion for an entire page.

## Harness rules

- CI owns the required E2E gate. It selects affected console and harness
  changes, runs the hermetic suite, and blocks `Verify` on a failure. Local
  E2E is optional; do not make it a delivery prerequisite.
- When local reproduction is useful, use
  `./tools/nx run @agent-lcars/console-e2e:e2e-local` so the documented
  credential-free environment is created consistently.
- Give each host-direct run a run-scoped Nx L1 cache. Another worktree must not
  be able to delete build output while the suite is using it.
- Keep affected-project selection conservative. If detection cannot prove that
  E2E is unaffected, run the suite instead of silently skipping it.
- On persistent runners, migrations that repair checkout prerequisites must run
  before `actions/checkout`. Guard cleanup by the exact stale hook content; do
  not remove unrelated hooks.
- Selectors must identify stable, resolved UI state. Do not solve streaming
  races with arbitrary sleeps.
- If E2E is expected to protect merges, its aggregate check must be required by
  branch policy. A post-merge run is a safety net, not a substitute for a PR
  gate.

The last item is a governance decision: Agent LCARS currently requires
`Verify`, while E2E is not a required check. Branch-policy changes are owned by
the Homelab Terraform workflow and need their own reviewed plan and apply.

## Triage a failure

1. Find the first failing stage. A checkout or setup failure is a harness
   incident, not a failed browser assertion.
2. Classify the failure using the four classes above before changing code or
   artifacts.
3. For a browser failure, inspect the Playwright report, trace, screenshot, and
   error context together.
4. When local reproduction will speed diagnosis, use `E2E_GREP` for the
   smallest stable test. Push the fix once the proportional local checks pass;
   CI owns the complete required E2E run.
5. Fix the product contract or harness cause. Never regenerate a baseline only
   to turn the check green.

## Review checklist

For every E2E change, reviewers should be able to answer:

- What user-observable contract does this assertion protect?
- Can time, seeded data, rendering, motion, or streaming make it vary?
- Does a semantic assertion express the contract more directly?
- Will failure artifacts make the problem diagnosable without a committed
  golden image?
- Does the affected-project logic run the test for every relevant source and
  workflow change?
- Does CI exercise the same setup path that developers are told to use?
- Can the required merge check actually see and enforce the result?

See [E2E security boundary](e2e-security-boundary.md) for environment isolation
and [the contributor verification guide](../.agents/skills/agent-lcars-dev/references/verify.md#console-e2e)
for commands.
