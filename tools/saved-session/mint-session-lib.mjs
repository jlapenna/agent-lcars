import { execFileSync } from 'node:child_process';

import { encode } from 'next-auth/jwt';

import { normalizeOrigin } from './saved-session-lib.mjs';

export const DEFAULT_AUTH_SECRET_NAME = 'AUTH_SECRET';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const VERIFICATION_SUBJECT = 'agent-lcars-production-verifier';

export function sessionCookieName(origin) {
  return `${new URL(normalizeOrigin(origin)).protocol === 'https:' ? '__Secure-' : ''}authjs.session-token`;
}

export function verificationTokenPayload() {
  return {
    sub: VERIFICATION_SUBJECT,
    name: 'Agent LCARS production verifier',
    githubLogin: VERIFICATION_SUBJECT,
    isAdmin: true,
    verificationSession: true,
  };
}

export function readSecretValue(
  secretName,
  project,
  { runFile = execFileSync } = {},
) {
  let value;
  try {
    value = runFile(
      'gcloud',
      [
        'secrets',
        'versions',
        'access',
        'latest',
        `--secret=${secretName}`,
        `--project=${project}`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    throw new Error(
      `Could not read ${secretName} from ${project}. Minting requires a maintainer identity with secretAccessor on that secret.`,
    );
  }

  const normalized = value.trimEnd();
  if (!normalized) {
    throw new Error(`${project}/${secretName} is empty.`);
  }
  return normalized;
}

export async function mintStorageState(
  { authSecret, origin, now = Date.now() },
  { encodeToken = encode } = {},
) {
  if (!authSecret) throw new Error('The Auth.js secret must not be empty.');

  const normalizedOrigin = normalizeOrigin(origin);
  const url = new URL(normalizedOrigin);
  const cookieName = sessionCookieName(normalizedOrigin);
  const expires = Math.floor(now / 1000) + SESSION_MAX_AGE_SECONDS;
  const token = await encodeToken({
    secret: authSecret,
    salt: cookieName,
    maxAge: SESSION_MAX_AGE_SECONDS,
    token: verificationTokenPayload(),
  });

  return {
    cookies: [
      {
        name: cookieName,
        value: token,
        domain: url.hostname,
        path: '/',
        expires,
        httpOnly: true,
        secure: url.protocol === 'https:',
        sameSite: 'Lax',
      },
    ],
    origins: [],
  };
}
