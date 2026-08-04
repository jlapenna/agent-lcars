---
name: verifying-console-session
description: Capture and reuse a real authenticated Agent LCARS browser session for production UI verification. Use when asked to test, inspect, screenshot, or verify the live auth-walled LCARS console with a saved admin or authenticated-user session instead of asking someone to log in again.
---

# Saved LCARS browser sessions

Use the repository-owned `tools/saved-session` commands to capture a real
Auth.js browser session once and reuse it for approved LCARS UI verification.
This complements the hermetic Playwright suite: emulator E2E proves application
behavior, while a saved session can prove that the deployed auth and page path
work together in production.

The mandatory worktree, PR, deployment, Terraform, credential, and Firestore
guardrails remain in
[agent-lcars-dev](../agent-lcars-dev/SKILL.md#hard-guardrails). This workflow
does not weaken them.

## Safety boundary

- A saved Playwright storage state contains a live session cookie. Treat it as
  a bearer credential: never print it, attach it to an issue/PR, commit it, or
  place it in a shared scratch directory.
- The capture step is deliberately interactive. A human completes GitHub
  sign-in in the headed browser; an agent never types, requests, or handles
  login credentials.
- Prefer a dedicated verification identity for any state shared through
  Secret Manager. A personal session should remain in the private local
  backend and only be captured when its owner explicitly chooses to do so.
- Use `--click` only for an already approved, non-destructive action. Never use
  this tool to dispatch work, cancel/retrigger runs, submit Quick Tasks, change
  labels, or otherwise mutate live state. Production mutations belong in
  reviewed application or maintenance paths.
- The Secret Manager backend only adds/reads secret versions. It intentionally
  cannot create a secret container or change IAM. LCARS infrastructure owns
  those resources; if a container or grant is missing, stop for the maintainer
  rather than touching `infra/terraform` or running direct IAM commands.

## Roles

`--role admin` requires the Auth.js session payload to contain
`user.isAdmin: true`. `--role user` means any authenticated user session; an
admin also satisfies it. It does not claim the identity is a non-admin.

The production console is currently single-admin and rejects other GitHub
logins during sign-in, so `user` is chiefly useful when a test only needs to
assert authentication rather than admin status. Use `admin` when verifying an
admin-only path.

## Storage backends

The default `local` backend is ready without infrastructure. It writes a raw,
directly reusable Playwright storage state with directory mode `0700` and file
mode `0600`:

```text
${XDG_STATE_HOME:-~/.local/state}/agent-lcars/sessions/<role>.json
```

Override it with `--state-file <path>` when another test harness needs a known
location. Its containing directory must already be private (`0700`), or the
tool refuses to write without changing the caller-owned directory's
permissions. Keep that location outside the repository; `.auth/` is ignored
only as a last defensive layer, not an invitation to put credentials in the
tree.

The optional `secret` backend stores base64-encoded storage state as a new
version of an existing secret in project `agent-lcars`:

| Role    | Default secret                    |
| ------- | --------------------------------- |
| `admin` | `AGENT_LCARS_ADMIN_STORAGE_STATE` |
| `user`  | `AGENT_LCARS_USER_STORAGE_STATE`  |

Use `--project` or `--secret-name` only for an intentionally provisioned
alternative. Capture needs permission to add a version; reuse needs
secret-version access. The scripts never create the container or its grants.

## Capture

From the repository root:

```bash
# Private state on this workstation (default)
pnpm session:capture --role admin

# Shared/headless reuse, after the secret container and grants exist
pnpm session:capture --role admin --storage secret
```

The command opens `https://agent-console.supersprinkles.racing/login`, waits
for the human to finish GitHub sign-in, validates `/api/auth/session`, checks
the requested role, and only then saves the browser storage state. Override
the deployment with `--origin <http(s)-origin>` for an explicitly intended
test environment.

## Reuse and verify

```bash
pnpm session:verify --role admin \
  --path /sessions \
  --wait-for 'text=Sessions' \
  --assert-text 'Session archive' \
  --screenshot /tmp/lcars-sessions.png
```

For the secret backend, add `--storage secret`. The command loads the saved
state into a fresh headless browser, verifies the live Auth.js session and
role, requires the requested path not to redirect, performs optional visible
selector/text checks, and captures a screenshot. Screenshots default to
full-page; pass `--screenshot-mode viewport` for a focused view.

Exit codes:

- `0`: requested authenticated page and assertions passed.
- `1`: invalid arguments, unavailable storage, selector/assertion failure, or
  another operational error.
- `2`: the saved session is expired or revoked; repeat the interactive capture.
- `3`: the session authenticates but has the wrong role or the page redirected
  elsewhere.

Auth.js JWT sessions are finite-lived credentials. The saved file/secret does
not silently refresh itself; recapture when the command reports exit code 2 or
after an explicit sign-out/revocation.
