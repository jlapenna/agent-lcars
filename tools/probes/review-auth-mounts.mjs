// A native review authenticates with the caller's subscriptions, but it must
// not reach the caller's provider directories: they configure the caller's
// live sessions (settings, hooks, plugins, skills, rules, MCP servers, memory,
// sourced shell state), and a review once rewrote one (#3379). Each review
// gets a fresh private provider home, and nothing it does can change a
// rotating login the caller's sessions depend on:
//
// - Claude uses the long-lived, non-rotating CLAUDE_CODE_OAUTH_TOKEN the fleet
//   uses (`claude setup-token`; docs/fleet-credentials.md), mounted read-only.
//   The caller's ~/.claude is not involved.
// - Codex has no long-lived token, so the caller's auth.json is bound
//   read-only. Codex refreshes its login at a known time (access-token expiry
//   or last_refresh + 8 days); when that falls inside the run, the launcher
//   first lets the refresh happen on the host, in the caller's own directory,
//   and only then starts the review.
// - Antigravity's token is bound read-only, as the fleet runner copies it; its
//   refresh token does not rotate, so in-memory refreshes are harmless.
//
// Bind targets live in the private home, so a host-side replace of a bound
// file only detaches the review from it; the caller's directory is never
// exposed.
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const NATIVE_CREDENTIALS = {
  claude: [],
  codex: ['auth.json'],
  agy: ['antigravity-oauth-token'],
  // The OpenCode lane binds a single key file, not a directory.
  opencode: null,
};

export const CLAUDE_TOKEN_SECRET = {
  secret: 'CLAUDE_CODE_OAUTH_TOKEN',
  project: 'agent-lcars',
  target: '/run/secrets/claude-code-oauth-token',
};

function credentialsFor(provider) {
  if (!(provider in NATIVE_CREDENTIALS))
    throw new Error('Unknown provider: ' + provider);
  return NATIVE_CREDENTIALS[provider];
}

// Mounts for a private provider home at `target` holding only the caller's
// read-only credential files. privateHome must not exist yet.
export function nativeAuthMounts(provider, auth, privateHome, target) {
  const credentials = credentialsFor(provider);
  if (credentials === null) return [];
  if (
    [privateHome, target, ...(credentials.length ? [auth] : [])].some((path) =>
      path.includes(','),
    )
  )
    throw new Error('Unsupported bind-mount path');
  mkdirSync(privateHome, { mode: 0o700 });
  const mounts = [
    '--mount',
    `type=bind,source=${privateHome},target=${target}`,
  ];
  for (const name of credentials) {
    const source = join(auth, name);
    const stat = lstatSync(source, { throwIfNoEntry: false });
    if (!stat?.isFile())
      throw new Error(
        'Native credential is missing or not a regular file: ' + source,
      );
    // The bind needs a mount point; it lives in the private home.
    closeSync(
      openSync(
        join(privateHome, name),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      ),
    );
    mounts.push(
      '--mount',
      `type=bind,source=${source},target=${join(target, name)},readonly`,
    );
  }
  return mounts;
}

const CODEX_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60 * 1000;
export const REFRESH_MARGIN_MS = 30 * 60 * 1000;

function jwtExpiryMs(token) {
  const payload = typeof token === 'string' ? token.split('.')[1] : undefined;
  if (!payload) return null;
  const exp = JSON.parse(Buffer.from(payload, 'base64url').toString()).exp;
  return typeof exp === 'number' ? exp * 1000 : null;
}

// When Codex will next refresh the caller's login, or null if unreadable.
export function codexRefreshDueMs(auth) {
  const { tokens, last_refresh: lastRefresh } = JSON.parse(
    readFileSync(join(auth, 'auth.json'), 'utf8'),
  );
  const expiry = jwtExpiryMs(tokens?.access_token);
  const refreshed = Date.parse(lastRefresh);
  if (expiry === null || Number.isNaN(refreshed)) return null;
  return Math.min(expiry, refreshed + CODEX_REFRESH_INTERVAL_MS);
}

// Make sure no Codex refresh can fall inside the run. If one is due, wait for
// it and let it happen on the host (a live session's next request, or a
// minimal host request through `refresh`), then re-check. A launch fails only
// when the host itself cannot refresh the login.
export async function ensureCodexLoginOutlivesRun({
  auth,
  runMs,
  refresh,
  now = Date.now,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  log = (message) => console.error(message),
  attempts = 3,
}) {
  for (let attempt = 0; ; attempt += 1) {
    const due = codexRefreshDueMs(auth);
    if (due !== null && due >= now() + runMs + REFRESH_MARGIN_MS) return;
    if (attempt >= attempts)
      throw new Error(
        'The Codex login could not be refreshed on the host before the review; ' +
          'run any Codex command to check the login, then retry.',
      );
    if (due !== null && due > now()) {
      log(
        `Codex refreshes its login at ${new Date(due).toISOString()}, inside ` +
          'this review; waiting for that refresh to happen on the host first.',
      );
      await sleep(due - now() + 60 * 1000);
      // A live host session may refresh on its own first.
      const after = codexRefreshDueMs(auth);
      if (after !== null && after >= now() + runMs + REFRESH_MARGIN_MS) return;
    }
    log('Refreshing the Codex login on the host before the review.');
    await refresh();
  }
}
