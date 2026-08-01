# E2E security boundary

Console E2E does not need production credentials. Its GitHub API is a local
fixture, Firebase uses the `demo-no-project` emulators, and every credential-like
value in `tools/e2e/ci.env` is a documented dummy value.

Run the local or CI suite through:

```sh
./tools/e2e-local.sh
```

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
