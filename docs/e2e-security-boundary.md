# E2E security boundary

Console E2E does not need production credentials. Its GitHub API is a local
fixture, Firebase uses the `demo-no-project` emulators, and every credential-like
value in `tools/e2e/ci.env` is a documented dummy value.

Run the local or CI suite through:

```sh
./tools/e2e-local.sh
```

Scope a host run without leaving the boundary by setting `E2E_GREP`, for
example `E2E_GREP='@smoke' ./tools/e2e-local.sh`.

The public and internal Nx targets support only the `emulator` execution path.
They retain an explicit `live` tombstone because Nx silently falls back to the
default configuration when a named configuration is absent. The tombstone
exits before entering any test tooling and explains that real Firebase
configuration conflicts with this dummy-only boundary. A live write-path
canary must use a separately validated design with explicit authorization,
never the direct `e2e-run` target.

## Production dispatch-broker canary (#307)

The dispatch broker's own GitHub write/routing path -- issue creation,
label-driven dispatch, workflow-run binding, and the explicit worker
completion callback -- is separately, continuously verified in production by
`.github/workflows/dispatch-canary.yml` (hourly + `workflow_dispatch`) and
`.github/workflows/post-deploy-smoke.yml` (chained off `deploy-console.yml`
completing). Both share `.github/actions/run-dispatch-canary`, which creates
a dedicated, clearly-marked issue, dispatches it through
`agent-router.yml`'s real broker (`dispatch-broker/normalize.mjs`'s
`kind: 'canary'` intent, a fourth pipeline alongside claude/codex/opencode --
see `dispatch-broker/broker.mjs`), and drives it to a dedicated no-op worker,
`agent-dispatch-canary.yml`.

That worker is structurally incapable of invoking a paid model or a
privileged/self-hosted runner: it runs on `ubuntu-latest` (never
`vars.AGENT_RUNNER_LABEL`), holds no secret beyond GitHub's own ambient
per-job token, performs no model invocation, GCP authentication, or
repository checkout-and-write beyond claiming/commenting/closing the anchor
issue, and unconditionally reports completion to the broker under
`if: always()` -- see `workflow-contract.test.mjs`'s "#307" checks, which
assert exactly these properties from the workflow source. `canary` is never
selectable through the `agent:*` label contract or the Quick Task agent
picker; the only way to produce that intent is the dedicated
`kind: 'canary'` `workflow_dispatch` branch, fired exclusively by this
repo's own two trusted canary workflows.

The post-deploy smoke additionally probes the live console URL for a 2xx
response before exercising the broker, so a broken deployed revision is
caught even before the write-path check runs. Either workflow's failure
parks `status:needs-human` (label + maintainer assignee) on the canary
issue with evidence and leaves it open, rather than a silent log line; a
successful run closes its issue automatically -- the acceptance bar for
"canary artifacts are automatically cleaned up." This proves the broker's
GitHub write path, not the deployed console's own server action writing to
GitHub through its runtime credential (`AGENT_LCARS_GITHUB_TOKEN`); that
remains a separately-scoped write-path E2E fixture effort in `apps/console`.

Cleanup above runs inside the same orchestrator process as the rest of the
lifecycle (a `try`/`catch` around create-dispatch-poll), so it cannot
survive that process being killed outright -- a job-level `timeout-minutes`
or a workflow/run cancellation tears down the runner before any further JS
executes, identical to the failure mode the epic design audit (#301)
describes for `deploy-console.yml`'s own job. Neither canary orchestrator
embeds a real production deploy the way `deploy-console.yml` does, so
there is no natural split into a separate same-workflow cleanup job here;
instead, `dispatch-canary.yml`'s existing hourly run also sweeps stale
canaries left behind by a previous run of either orchestrator
(`run.mjs`'s `sweepStaleCanaries`, `sweep-stale-canaries: true` only on
that caller): it lists open issues, filters to this canary's own title
prefix and marker, and for every candidate more than 30 minutes old --
comfortably past both orchestrators' `LEDGER_POLL_TIMEOUT_MS` and
`timeout-minutes: 15` budgets -- closes it if its ledger already shows a
successful completion or parks `status:needs-human` otherwise. This is the
deterministic-rediscovery scheduled/manual janitor backstop layer the
design audit calls for; a killed run's issue is still found and either
closed or flagged within one hour at the very most, not indefinitely.

The wrapper starts the Nx process with an empty environment, a temporary
`HOME`, the Nx daemon and Nx dotenv auto-loading disabled, and an explicit
allowlist. That list contains the build-time Firebase/Auth dummy values,
Playwright's browser location, the safe suite-selection controls (`E2E_GREP`,
`SKIP_VISUAL`, `VISUAL_ONLY`, and `UPDATE_SNAPSHOTS`), and the caller's
conventional Corepack and Firebase emulator cache paths. Keeping
`COREPACK_HOME` and `FIREBASE_EMULATORS_PATH` at those two derived locations
lets already installed package-manager and emulator distributions work offline
without exposing the rest of the caller's home as process configuration;
ambient cache overrides are not trusted.

Playwright's browser cache is also derived from the caller's home using the
platform default (`~/.cache/ms-playwright` on Linux,
`~/Library/Caches/ms-playwright` on macOS, or
`~/AppData/Local/ms-playwright` in Windows Bash environments). An explicit
`PLAYWRIGHT_BROWSERS_PATH` remains the supported escape hatch for custom
installations.

The wrapper deliberately does not load a developer's `.env.e2e` or
`.env.e2e.local`. The public Nx `e2e` target uses this wrapper too; only the
internal `e2e-implementation` target retains the dotenv compatibility
defaults, and it validates both files before loading them. Docker explicitly
points that internal target at the checked-in fixture and an empty
local-override path.

`tools/e2e/validate-env.mjs` rejects verbose `DEBUG` mode and any
credential-shaped key unless both its name and dummy value are explicitly
approved. It also rejects dotenv keys outside the checked-in fixture schema,
including process-injection controls such as `NODE_OPTIONS`. The internal
implementation target refuses to run without the isolation marker set by the
wrapper or Docker path. Its build is a separate uncached guard target that
validates the boundary before invoking the console build, so Nx cannot run a
dependency build ahead of the check. The same guard validates `.env` files that
Next.js would auto-load from `apps/console`, closing the file-based path around
the clean process environment. Validation errors name the unsafe key but never
echo its value.

## Credential incident follow-up

Before this boundary existed, a local run inherited an ambient OpenCode
provider credential and a dependency printed it while generic debug mode was
enabled. The credential value must never be copied into an issue, PR, test, or
log. A maintainer must rotate it at the provider, update the encrypted homelab
secret that supplies the runtime, and invalidate the prior value. Rotation is
tracked separately from this code repair so it cannot be mistaken for an
automated source change.
