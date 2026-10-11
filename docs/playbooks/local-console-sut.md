# Develop against the local console SUT

Use this playbook to iterate on the console and Work API without rebuilding
the standalone production bundle or restarting emulators for every change.
All commands below run from the root of your dedicated feature worktree.

## Prepare the worktree

Follow the [repository development guardrails](../../.agents/skills/agent-lcars-dev/SKILL.md)
to create a feature worktree. In that worktree, run:

```sh
./tools/setup-worktree.sh
node --version
java -version
```

Use the Node/pnpm versions pinned in `package.json` and Java 21, matching the
repository's emulator CI setup. Dependencies include the Firebase CLI
and Playwright; browser journeys require an installed Playwright Chromium:

```sh
node node_modules/@playwright/test/cli.js install chromium
```

No production credentials, cloud deployment, or production data are needed.
The supervisor validates `tools/e2e/ci.env` and Next.js dotenv sources before
startup, strips ambient credentials, and creates an ephemeral GitHub key.
Do not copy production dotenv files into this worktree.

## Start and share a preview

For a browser on another machine, select a real fully qualified DNS name
resolving to a private IPv4 interface on the serving host:

```sh
FQDN=dev.example.net ./tools/nx run @agent-lcars/console:serve-lan --port-base 4320
```

Replace `dev.example.net` with your host's FQDN. Wait for the supervisor's
`development stack ready` message, then open `http://dev.example.net:4320`.
The console is bound to the resolved private interface and loopback; Firebase
emulators and the GitHub fixture API remain loopback-only. Host/origin checks
protect the synthetic administrator from unapproved requests. This is a
trusted-LAN fixture preview, not a public authenticated service. Never forward
the port to the public internet.

For host-only iteration, use
`./tools/nx run @agent-lcars/console:serve-emulator`. It defaults to
loopback and port base 4300. Ambient `FQDN` does not opt this command into LAN
exposure. `--fqdn dev.example.net` explicitly enables LAN mode too. Next.js
receives the preview FQDN for hot reload; dotenv files are not changed.

Both serve targets are continuous, uncached Nx tasks without a production-build
dependency. Keep the foreground command running while you edit console source;
the browser updates through Next.js hot reload.

The supervisor reserves seven consecutive ports. Choose a non-overlapping
range for each concurrent worktree; it refuses occupied ports and never kills
another stack to claim them.

| Offset from base | Listener                         |
| ---------------- | -------------------------------- |
| 0                | Console                          |
| 1                | Firebase emulator UI (host-only) |
| 2                | Firestore                        |
| 3                | Firebase Auth                    |
| 4                | Emulator hub                     |
| 5                | Emulator logging                 |
| 6                | Firestore websocket              |

## Reset and test without restarting

Use another terminal in the same worktree with the same port base:

```sh
./tools/nx run @agent-lcars/console:dev-status --port-base 4320
./tools/nx run @agent-lcars/console:dev-reset --port-base 4320
./tools/nx run @agent-lcars/console-e2e:dev-test --port-base 4320
```

These are uncached Nx targets. They verify the stack's worktree and port
identity; they discover its FQDN automatically, so do not repeat `FQDN`.
Reset replaces the stack's synthetic data with populated fixtures. It is not
a production reset and cannot target a different worktree's stack.

The default test exercises the native Work edit/save/reload journey. To run
all native Work journeys or select one:

```sh
./tools/nx run @agent-lcars/console-e2e:dev-test --port-base 4320 native-work.spec.ts
./tools/nx run @agent-lcars/console-e2e:dev-test --port-base 4320 native-work.spec.ts --grep 'reply persists'
```

Tests reuse the running server and existing Playwright specs. They reset
synthetic data and restore populated fixtures afterward, including on test
failure. Do not browse or run another mutation suite against the same stack
while this is happening. Failure screenshots/traces remain in the temporary
diagnostics directory printed by the runner.

Auth-cookie and production-cache verification still use the
[hermetic standalone E2E workflow](../e2e-reliability.md). This dev server
injects a fixture administrator while preserving explicit E2E identity
headers; it does not prove production authentication.

## Know the system boundary

The real Work API and in-process Orchestrator write durable task, run, outbox,
and queue state to the Firestore emulator. External GitHub operations use
local synthetic fixtures and are not posted to GitHub. Browser changes do not
affect production state.

QueueExecutor, direct runners, provider processes, telemetry watcher, and
periodic reconciliation/schedule ticks are not started. Queued work does not
execute automatically. This is a console/control-plane integration SUT, not
a complete fleet execution SUT. See [lifecycle systems](../lifecycle-systems.md)
for the external services' ownership.

## Stop and troubleshoot

Press Ctrl-C in the foreground serve terminal. The supervisor closes browser
connections and shuts down its owned Next.js/Firebase processes, including
detached Firestore Java processes. Fixture state is disposable; a fresh start
seeds it again. Stop the stack before removing its worktree.

Keep the serve command in an owned terminal with a live output reader, not a
tool process whose lifetime ends when an agent turn is interrupted. If either
output pipe fails (for example `EPIPE` after its reader disconnects), the
supervisor stops its owned processes and exits nonzero instead of letting
Next.js repeatedly log to the broken pipe. This shutdown discards ephemeral
fixture state, just like Ctrl-C; it does not restart automatically.

| Symptom                            | Action                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Port already in use                | Stop your owning stack or choose another seven-port range; do not kill unrelated listeners.                                                     |
| Missing/invalid FQDN               | Supply a DNS name, not an IP, URL, or name containing a port.                                                                                   |
| FQDN does not resolve locally      | Correct DNS or use the FQDN of this serving host's private IPv4 interface.                                                                      |
| Preview returns 403                | Use the exact printed FQDN/port; remove an unapproved Origin or proxy Host rewrite.                                                             |
| Unsafe dotenv validation fails     | Inspect the named file/variable locally; isolate the worktree from production dotenv files. Never paste secret values into logs.                |
| Status/test reports wrong worktree | Run from the owning worktree and pass its port base.                                                                                            |
| Stack still warming                | Wait for the ready message; inspect foreground logs if startup fails.                                                                           |
| Browser cannot launch              | Install Chromium above, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing compatible Chromium binary.                                 |
| Browser test fails                 | Inspect the printed diagnostics directory, fix the failure, and rerun the same selection; no build/restart is needed for ordinary source edits. |

Next.js may regenerate tracked `apps/console/next-env.d.ts` for its dev type
paths. Treat that as generated development drift, not an intentional source
change; inspect it before staging and preserve the repository's canonical
production type imports.
