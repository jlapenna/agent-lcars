// A native review authenticates as the caller, but it must not reach the
// caller's provider directory: everything else there (settings, hooks,
// plugins, skills, rules, MCP servers, memory, sourced shell state) configures
// the caller's live sessions (#3379: a reviewed test registered the scratch
// repository's worker hook in the operator's settings.json).
//
// The review therefore gets a fresh private provider home, and only the
// credential file is bound into it, read-only, from the caller's directory.
// The bind target lives in the private home, so if the host replaces the
// credential file during the run (which detaches the bind), the review sees
// only its own placeholder; the caller's directory is never exposed.
//
// A read-only credential cannot accept a refreshed token, and a refresh the
// review cannot persist would leave the caller holding a used refresh token.
// So the launch is refused unless no refresh can fall inside the run: Claude
// refreshes as its access token nears expiresAt, and Codex refreshes when its
// access token expires or its last_refresh is older than 8 days.
// Antigravity's token file is used read-only, as the fleet runner does.
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
  claude: ['.credentials.json'],
  codex: ['auth.json'],
  agy: ['antigravity-oauth-token'],
  // The OpenCode lane binds a single key file, not a directory.
  opencode: null,
};

function credentialsFor(provider) {
  if (!(provider in NATIVE_CREDENTIALS))
    throw new Error('Unknown provider: ' + provider);
  return NATIVE_CREDENTIALS[provider];
}

const CODEX_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60 * 1000;
const REFRESH_MARGIN_MS = 30 * 60 * 1000;

// Milliseconds since the epoch of a JWT's exp, or null when it has none.
function jwtExpiryMs(token) {
  const payload = typeof token === 'string' ? token.split('.')[1] : undefined;
  if (!payload) return null;
  const exp = JSON.parse(Buffer.from(payload, 'base64url').toString()).exp;
  return typeof exp === 'number' ? exp * 1000 : null;
}

// When the provider CLI will next refresh the caller's login, or null when
// that cannot be determined.
function nextRefreshMs(provider, auth) {
  const read = (name) => JSON.parse(readFileSync(join(auth, name), 'utf8'));
  if (provider === 'claude') {
    const expiresAt = read('.credentials.json').claudeAiOauth?.expiresAt;
    return typeof expiresAt === 'number' ? expiresAt : null;
  }
  if (provider === 'codex') {
    const { tokens, last_refresh: lastRefresh } = read('auth.json');
    const expiry = jwtExpiryMs(tokens?.access_token);
    const refreshed = Date.parse(lastRefresh);
    if (expiry === null || Number.isNaN(refreshed)) return null;
    return Math.min(expiry, refreshed + CODEX_REFRESH_INTERVAL_MS);
  }
  return Infinity;
}

export function assertCredentialsOutliveRun(
  provider,
  auth,
  runMs,
  nowMs = Date.now(),
) {
  const next = nextRefreshMs(provider, auth);
  if (next === null || next < nowMs + runMs + REFRESH_MARGIN_MS)
    throw new Error(
      `The ${provider} login ` +
        (next === null
          ? 'has no readable expiry'
          : `refreshes at ${new Date(next).toISOString()}, inside this review`) +
        ". Retry after the caller's own sessions have refreshed it.",
    );
}

// Mounts for a private provider home at `target` holding only the caller's
// credential files. privateHome must not exist yet.
export function nativeAuthMounts(provider, auth, privateHome, target) {
  const credentials = credentialsFor(provider);
  if (credentials === null) return [];
  if ([auth, privateHome, target].some((path) => path.includes(',')))
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
