# Capture, mint, rotate and monitor a saved session

Read this when no saved state exists, when `check-session` or
`verify-session` reports exit `2` (expired/revoked) or `4` (expiring/unknown
expiry), or before configuring the daily readiness check. The
[safety boundary](../SKILL.md#safety-boundary) still applies: an agent never
handles login credentials, and minting or rotation is a maintainer action
that read-only workers must not run.

## Mint a dedicated verification session

The console uses Auth.js encrypted JWT sessions, so a maintainer can mint a
dedicated production-verifier session without creating or sharing a personal
GitHub login. The command reads `AUTH_SECRET` directly from Secret Manager,
uses Auth.js's own encoder and production cookie name, writes a 30-day admin
storage state, and never prints either credential:

```bash
# Inspect locally first (private file backend)
./tools/nx run @agent-lcars/console:mint-session

# Publish a version for read-only headless agents
./tools/nx run @agent-lcars/console:mint-session -- --storage secret
```

Minting is an operator bootstrap/rotation action. It requires access to both
`AUTH_SECRET` and the destination's `secretVersionAdder` permission. Reuse
requires only `secretAccessor` on `AGENT_LCARS_ADMIN_STORAGE_STATE`; do not
grant the agent identity access to `AUTH_SECRET`. The minted subject is
`agent-lcars-production-verifier`, distinct from the maintainer's GitHub
identity. Use the interactive capture flow below only when verifying the real
OAuth login path itself.

## Capture interactively

Apply the
[local browser phase preflight](../SKILL.md#verify-a-production-page)
(step 3) before capture as well. From the repository root:

```bash
# Private state on this workstation (default)
./tools/nx run @agent-lcars/console:capture-session -- --role admin

# Shared/headless reuse, after the secret container and grants exist
./tools/nx run @agent-lcars/console:capture-session -- \
  --role admin --storage secret
```

The command opens `https://lcars.jlapenna.net/login`, waits
for the human to finish GitHub sign-in, validates `/api/auth/session`, checks
the requested role, and only then saves the browser storage state. Override
the deployment with `--origin <http(s)-origin>` for an explicitly intended
test environment.

## Rotate on an expiry warning

On an expiry warning, an approved maintainer rotates the dedicated admin state
with this exact scoped command (read-only workers must not run it):

```bash
./tools/nx run @agent-lcars/console:mint-session -- \
  --storage secret --origin https://lcars.jlapenna.net --project agent-lcars \
  --secret-name AGENT_LCARS_ADMIN_STORAGE_STATE --auth-secret-name AUTH_SECRET
```

After rotation, run `check-session` (SKILL.md step 2), follow the local browser workflow
(step 3), then prove the admin session and the intended page with the
supported browser verifier:

```bash
./tools/nx run @agent-lcars/console:verify-session -- \
  --role admin --storage secret --origin https://lcars.jlapenna.net \
  --project agent-lcars --minimum-valid-days 14 --path / \
  --wait-for main --assert-text Bridge
```

## Daily operator-owned readiness check

For a daily operator-owned check, configure the following command in the
existing private monitoring environment, with its saved-state read identity
and absolute repository path. Keep stdout/stderr in private operator logs;
alert routing and installation of the schedule belong to that environment.
This is a configuration handoff, not an installed cron job or public alert:

```bash
# Daily at 08:00 in the operator scheduler's timezone
0 8 * * * cd /absolute/path/to/agent-lcars && timeout 60s node tools/saved-session/check.mjs --role admin --storage secret --origin https://lcars.jlapenna.net --project agent-lcars --minimum-valid-days 14
```
