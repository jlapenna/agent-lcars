---
name: verifying-console-session
description: Check, reuse, capture, mint or rotate a real authenticated Agent LCARS browser session with the repository's tools/saved-session commands (check-session, verify-session, capture-session, mint-session) to verify, inspect or screenshot the live auth-walled LCARS console at lcars.jlapenna.net. Use whenever a task asks to test or prove a production console page, admin-only route or deployed login path with a saved admin or user session instead of asking someone to log in again, or when a saved session is expired, expiring or missing. Not for hermetic emulator Playwright E2E (agent-lcars-dev owns that), not for mutating live state, and not for driving a person's signed-in shared Chrome.
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
  place it in a shared scratch directory. Keep any `--state-file` outside the
  repository.
- The capture step is deliberately interactive. A human completes GitHub
  sign-in in the headed browser; an agent never types, requests, or handles
  login credentials. The mint step is the non-interactive alternative for a
  dedicated verification session: it requires maintainer access to the
  production `AUTH_SECRET`, which the read-only agent identity must never
  receive. Minting and rotation are maintainer actions; read-only workers must
  not run them.
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

## Verify a production page

Run every command from the repository root.

1. **Pick the role and backend.** The default `local` backend is a private
   file on this workstation; `--storage secret` reads the shared
   `AGENT_LCARS_<ROLE>_STORAGE_STATE` secret in project `agent-lcars`. Read
   [references/storage-backends.md](references/storage-backends.md) before
   using `--state-file`, `--project` or `--secret-name`, or when a backend
   path, mode or permission is in question.

2. **Check readiness.** This read-only check needs only access to the saved
   state, checks the live Auth.js role without launching a browser, and
   reports the cookie deadline and the last safe rotation time for the
   default 14-day validity window:

   ```bash
   ./tools/nx run @agent-lcars/console:check-session -- \
     --role admin --storage secret --origin https://lcars.jlapenna.net \
     --project agent-lcars --minimum-valid-days 14
   ```

   Exit codes are `0` ready, `1` unavailable/invalid request, `2` expired or
   revoked, `3` wrong role, and `4` expiring or unknown expiry. The request
   has a 10-second timeout; Secret Manager access has a 20-second timeout. It does not rotate or refresh a credential and never saves response cookies. A pass proves authentication
   and the rotation window, not host capacity or resource guards. On `2` or
   `4`, or when no saved state exists yet, read
   [references/capture-mint-rotate.md](references/capture-mint-rotate.md).

3. **Qualify the local browser phase.** Before browser capture, reuse or
   browser-cache installation, read and apply
   [Bounded local verification](../agent-lcars-dev/references/verify.md#bounded-local-verification)
   at the launch decision. Keep capacity, supervisor, accounting and storage
   requirements in that authoritative owner; this skill supplies the
   saved-session sequence. Keep failed guard receipts distinct from later functional evidence.
   Checking this route establishes the handoff, not future agent behavior or
   resource enforcement. Read-only credential readiness (step 2) remains a
   separate check.

4. **Install the matching headless shell** for this checkout's Playwright
   package (re-run after a Playwright upgrade):

   ```bash
   pnpm exec playwright install chromium --only-shell
   ```

   This is an explicit, unprivileged browser-cache step. The verifier never
   downloads a browser, installs operating-system packages, or uses `sudo`.
   Playwright's host-library dependencies remain a workstation prerequisite
   managed through the host's normal reviewed setup path; never add
   `--with-deps` to a verification run. Do not substitute an older cached browser or a
   person's signed-in shared Chrome.

5. **Verify the page.** For the secret backend, add `--storage secret`:

   ```bash
   ./tools/nx run @agent-lcars/console:verify-session -- \
     --role admin \
     --path /sessions \
     --wait-for 'text=Sessions' \
     --assert-text 'Session archive' \
     --screenshot /tmp/lcars-sessions.png
   ```

   The command loads the saved state into a fresh headless browser, verifies
   the live Auth.js session and role, requires the requested path not to
   redirect, performs optional visible selector/text checks, and captures a
   screenshot (full-page by default; `--screenshot-mode viewport` for a
   focused view). `--minimum-valid-days 14` applies the same expiry
   classifier as `check-session` before navigation. Its executable preflight
   runs before saved state is read and before browser launch, and reports `BROWSER_RUNTIME_UNAVAILABLE`
   separately from credential, role, redirect and assertion failures.

   | Exit | Meaning                                                                                                     |
   | ---- | ----------------------------------------------------------------------------------------------------------- |
   | `0`  | Requested authenticated page and assertions passed.                                                         |
   | `1`  | Invalid arguments, unavailable storage, selector/assertion failure, or another operational error.           |
   | `2`  | Saved session expired or revoked; repeat the interactive capture.                                           |
   | `3`  | Session authenticates but has the wrong role, or the page redirected elsewhere.                             |
   | `4`  | Expiry unknown or inside the requested `--minimum-valid-days` safety window; rotate it before the deadline. |
   | `5`  | Matching Playwright Chromium headless-shell executable not ready; run the step 4 install and retry.         |

Auth.js JWT sessions are finite-lived credentials. The saved file/secret does
not silently refresh itself; recapture when a command reports exit code 2 or
after an explicit sign-out/revocation.

## Capture, mint, rotate or monitor

Read [references/capture-mint-rotate.md](references/capture-mint-rotate.md)
before capturing a session interactively, minting or rotating the dedicated
verifier session, accepting a rotation, or configuring the daily
operator-owned readiness check.
