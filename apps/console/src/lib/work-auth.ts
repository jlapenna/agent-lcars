import 'server-only';

import { createRemoteJWKSet, jwtVerify } from 'jose';

import { resolvePrincipal, type WorkGrant } from './work-grants';

export type WorkScope = 'work.operator';

export interface WorkPrincipal {
  principal: string;
  subject: string;
  scopes: ReadonlySet<WorkScope>;
  pipelines: readonly string[];
  via: 'google' | 'session';
}

export interface WorkAuthDeps {
  verifyGoogleIdToken: (
    token: string,
  ) => Promise<{ email: string; emailVerified: boolean }>;
  session: () => Promise<{ user?: { login?: string } } | null>;
  grants: () => WorkGrant[];
}

const GOOGLE_ISSUER = 'https://accounts.google.com';
const googleJwks = createRemoteJWKSet(
  new URL('https://www.googleapis.com/oauth2/v3/certs'),
);

/** A Google-signed ID token for our audience. Service-account identity
 *  tokens (impersonated or direct) carry `email` + `email_verified`. */
export function googleIdTokenVerifier(
  audience: string,
): WorkAuthDeps['verifyGoogleIdToken'] {
  return async (token) => {
    const { payload } = await jwtVerify(token, googleJwks, {
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
    scopes: new Set<WorkScope>(['work.operator']),
    pipelines: grant.pipelines,
    via,
  };
}

/**
 * Bearer token first; an Auth.js session only when no bearer header is
 * present. A bearer that fails never falls back to the session -- a
 * caller that presented a credential gets judged on it.
 */
export async function authenticateWorkRequest(
  request: Request,
  deps: WorkAuthDeps,
): Promise<WorkPrincipal | undefined> {
  const header = request.headers.get('authorization');
  if (header !== null) {
    const match = /^Bearer\s+(\S+)$/iu.exec(header);
    if (match === null) return undefined;
    try {
      const { email, emailVerified } = await deps.verifyGoogleIdToken(
        match[1] ?? '',
      );
      if (!emailVerified || email === '') return undefined;
      return principalFor(email, 'google', deps.grants());
    } catch {
      return undefined;
    }
  }
  const login = (await deps.session())?.user?.login;
  return login === undefined
    ? undefined
    : principalFor(`github:${login}`, 'session', deps.grants());
}
