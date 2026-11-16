// A native review authenticates as the caller, but it must not reach the
// caller's provider directory: everything else there (settings, hooks,
// plugins, skills, rules, MCP servers, memory, sourced shell state) configures
// the caller's live sessions (#3379: a reviewed test registered the scratch
// repository's worker hook in the operator's settings.json).
//
// The review therefore gets a fresh private provider home, and only the
// credential file is bound into it from the caller's directory. The bind
// target lives in the private home, so if the host replaces the credential
// file during the run (which detaches the bind), the review sees only its own
// placeholder; the caller's directory is never exposed.
//
// Claude rotates its OAuth token often, so its credential is bound
// read-write: Claude stages a temporary file and, when the rename onto the
// bound file fails with EBUSY, rewrites the file in place, so a rotation
// reaches the caller's sessions. Codex refreshes only when its access token is
// old, so the launch is refused when that token would expire during the run
// and the file is bound read-only. Antigravity's token file is used read-only,
// as the fleet runner does.
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
  claude: [{ name: '.credentials.json', writable: true }],
  codex: [{ name: 'auth.json', writable: false }],
  agy: [{ name: 'antigravity-oauth-token', writable: false }],
  // The OpenCode lane binds a single key file, not a directory.
  opencode: null,
};

function credentialsFor(provider) {
  if (!(provider in NATIVE_CREDENTIALS))
    throw new Error('Unknown provider: ' + provider);
  return NATIVE_CREDENTIALS[provider];
}

// Seconds until a JWT's exp, or null when it carries none.
function jwtSecondsLeft(token, nowMs) {
  const payload = typeof token === 'string' ? token.split('.')[1] : undefined;
  if (!payload) return null;
  const exp = JSON.parse(Buffer.from(payload, 'base64url').toString()).exp;
  return typeof exp === 'number' ? exp - nowMs / 1000 : null;
}

// Codex persists a refreshed token, which a read-only credential cannot
// accept. Require the access token to outlive the run with a margin.
export function assertCredentialsOutliveRun(
  provider,
  auth,
  runMs,
  nowMs = Date.now(),
) {
  if (provider !== 'codex') return;
  const tokens = JSON.parse(
    readFileSync(join(auth, 'auth.json'), 'utf8'),
  ).tokens;
  const left = jwtSecondsLeft(tokens?.access_token, nowMs);
  if (left === null || left < runMs / 1000 + 30 * 60)
    throw new Error(
      'The Codex access token expires before this review could finish. ' +
        'Run any Codex command to refresh the login, then retry.',
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
  for (const { name, writable } of credentials) {
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
      `type=bind,source=${source},target=${join(target, name)}${writable ? '' : ',readonly'}`,
    );
  }
  return mounts;
}
