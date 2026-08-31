import 'server-only';

import { createRemoteJWKSet, jwtVerify } from 'jose';

import { resolvePrincipal, type WorkGrant } from './work-grants';

export type WorkScope =
  'work.operator' | 'work.executor' | 'work.cron' | 'work.reaper';

export interface WorkPrincipal {
  principal: string;
  subject: string;
  scopes: ReadonlySet<WorkScope>;
  pipelines: readonly string[];
  via: 'google' | 'session' | 'oidc';
  /** Present only for a GitHub Actions OIDC identity. GitHub-anchor
   * dispatch keeps the anchor bound to this signed source repository. */
  sourceRepository?: string;
}

export interface WorkAuthDeps {
  verifyGoogleIdToken: (
    token: string,
  ) => Promise<{ email: string; emailVerified: boolean }>;
  /** GitHub Actions OIDC verifier for the session-pin-tick trigger
   *  (`work-session-pin-tick.yml`, sub-project 6). */
  verifySessionPinTickOidcToken: (token: string) => Promise<unknown>;
  /** Generic GitHub Actions Work API identity. Its verifier establishes the
   * signed repository and canonical Work-grant subject; this module only
   * resolves that subject through the ordinary grant model. */
  verifyGithubActionsWorkOidcToken: (
    token: string,
  ) => Promise<{ repository: string; subject: string }>;
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

/** Extracts the raw bearer token from `Authorization: Bearer <token>`,
 *  verbatim -- no verification. `route.ts` uses this to populate
 *  `RunsContext.bearerToken` for the run-token routes, which hash and
 *  compare it against a claimed run's own `queue.tokenHash` rather than
 *  verifying it as a Google ID token the way `authenticateWorkRequest`
 *  does below. Kept as a small, separately-testable duplicate of the same
 *  regex `authenticateWorkRequest` uses inline, not a refactor of that
 *  function's control flow. */
export function rawBearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  const match = header === null ? null : /^Bearer\s+(\S+)$/iu.exec(header);
  return match?.[1];
}

/**
 * Bearer token first, tried against Google and the two GitHub Actions OIDC
 * identities; an Auth.js session only when no bearer header is present.
 * A bearer that fails every verifier never falls back to the session -- a
 * caller that presented a credential is judged on it.
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
      // confirmed identity (unverified or empty email) -- refused outright.
      // A caller that presented a credential is judged on it; this is not
      // the "not a Google token at all" case the catch below is for.
      return undefined;
    } catch {
      // Not a Google-issued token for our audience -- fall through to the
      // one remaining GitHub Actions OIDC caller below.
    }
    try {
      await deps.verifySessionPinTickOidcToken(token);
      return {
        principal: 'pin:tick',
        subject: 'pin:tick',
        scopes: new Set<WorkScope>(['work.reaper']),
        pipelines: [],
        via: 'oidc',
      };
    } catch {
      // Not the dedicated read-only reaper identity either. A normal
      // GitHub Actions caller may still resolve through a configured Work
      // grant below.
    }
    try {
      const identity = await deps.verifyGithubActionsWorkOidcToken(token);
      const principal = principalFor(identity.subject, 'oidc', deps.grants());
      return principal === undefined
        ? undefined
        : { ...principal, sourceRepository: identity.repository };
    } catch {
      return undefined;
    }
  }
  const login = (await deps.session())?.user?.login;
  return login === undefined
    ? undefined
    : principalFor(`github:${login}`, 'session', deps.grants());
}
