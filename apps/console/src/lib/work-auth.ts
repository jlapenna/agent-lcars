import 'server-only';

import { createRemoteJWKSet, jwtVerify } from 'jose';

import { resolvePrincipal, type WorkGrant } from './work-grants';

export type WorkScope = 'work.operator' | 'work.executor' | 'work.cron';

export interface WorkPrincipal {
  principal: string;
  subject: string;
  scopes: ReadonlySet<WorkScope>;
  pipelines: readonly string[];
  via: 'google' | 'session' | 'oidc';
}

export interface WorkAuthDeps {
  verifyGoogleIdToken: (
    token: string,
  ) => Promise<{ email: string; emailVerified: boolean }>;
  /** GitHub Actions OIDC verifier for the scheduled tick trigger
   *  (`work-schedules-tick.yml`). Only reached when the bearer is not a
   *  valid Google token for our audience -- see `authenticateWorkRequest`
   *  below. Resolves on a trusted token, throws otherwise; the identity
   *  itself is not needed past "this is the trusted tick caller". */
  verifyScheduleTickOidcToken: (token: string) => Promise<unknown>;
  session: () => Promise<{ user?: { login?: string } } | null>;
  grants: () => WorkGrant[];
}

const GOOGLE_ISSUER = 'https://accounts.google.com';
const googleJwks = createRemoteJWKSet(
  new URL('https://www.googleapis.com/oauth2/v3/certs'),
);

/** A Google-signed ID token for our audience. Service-account identity
 *  tokens (impersonated or direct) carry `email` + `email_verified`. The
 *  `jwks` parameter defaults to the module-scoped, lazily-fetched Google
 *  key set; tests pass a local key set instead so verification never makes
 *  a real network call. */
export function googleIdTokenVerifier(
  audience: string,
  jwks: Parameters<typeof jwtVerify>[1] = googleJwks,
): WorkAuthDeps['verifyGoogleIdToken'] {
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: GOOGLE_ISSUER,
      audience,
    });
    return {
      email: typeof payload['email'] === 'string' ? payload['email'] : '',
      emailVerified: payload['email_verified'] === true,
    };
  };
}

function principalFor(
  subject: string,
  via: WorkPrincipal['via'],
  grants: WorkGrant[],
): WorkPrincipal | undefined {
  const grant = resolvePrincipal(subject, grants);
  if (grant === undefined) return undefined;
  return {
    principal: grant.principal,
    subject,
    scopes: new Set<WorkScope>(grant.scopes ?? ['work.operator']),
    pipelines: grant.pipelines,
    via,
  };
}

/**
 * Bearer token first, tried against Google and then, on failure, against
 * the schedule-tick OIDC verifier; an Auth.js session only when no bearer
 * header is present. A bearer that fails both never falls back to the
 * session -- a caller that presented a credential is judged on it.
 */
export async function authenticateWorkRequest(
  request: Request,
  deps: WorkAuthDeps,
): Promise<WorkPrincipal | undefined> {
  const header = request.headers.get('authorization');
  if (header !== null) {
    const match = /^Bearer\s+(\S+)$/iu.exec(header);
    if (match === null) return undefined;
    const token = match[1] ?? '';
    try {
      const { email, emailVerified } = await deps.verifyGoogleIdToken(token);
      if (emailVerified && email !== '') {
        return principalFor(email, 'google', deps.grants());
      }
      // Verified as a Google token for our audience, but carrying no
      // confirmed identity (unverified or empty email) -- refused outright,
      // never retried against the schedule-tick OIDC verifier below. A
      // caller that presented a credential is judged on it; this is not
      // the "not a Google token at all" case the catch below is for.
      return undefined;
    } catch {
      // Not a Google-issued token for our audience -- fall through to the
      // GitHub Actions schedule-tick branch below.
    }
    try {
      await deps.verifyScheduleTickOidcToken(token);
      return {
        principal: 'cron:tick',
        subject: 'cron:tick',
        scopes: new Set<WorkScope>(['work.cron']),
        pipelines: [],
        via: 'oidc',
      };
    } catch {
      return undefined;
    }
  }
  const login = (await deps.session())?.user?.login;
  return login === undefined
    ? undefined
    : principalFor(`github:${login}`, 'session', deps.grants());
}
