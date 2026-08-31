import { describe, expect, it } from 'vitest';

import { authenticateWorkRequest, type WorkAuthDeps } from './work-auth';
import { parseWorkGrants } from './work-grants';

const grants = parseWorkGrants(
  JSON.stringify([
    {
      principal: 'user:jlapenna',
      subjects: ['sa@example.iam.gserviceaccount.com', 'github:jlapenna'],
      pipelines: ['claude'],
    },
  ]),
);
function deps(over: Partial<WorkAuthDeps> = {}): WorkAuthDeps {
  return {
    verifyGoogleIdToken: async () => ({
      email: 'sa@example.iam.gserviceaccount.com',
      emailVerified: true,
    }),
    verifySessionPinTickOidcToken: async () => {
      throw new Error('not a session-pin-tick token');
    },
    verifyGithubActionsWorkOidcToken: async () => {
      throw new Error('not a GitHub Actions Work API token');
    },
    session: async () => null,
    grants: () => grants,
    ...over,
  };
}
const req = (headers: Record<string, string> = {}) =>
  new Request('https://lcars.test/api/work/v1/items', { headers });

describe('authenticateWorkRequest', () => {
  it('maps a verified Google service-account token to its principal', async () => {
    const p = await authenticateWorkRequest(
      req({ authorization: 'Bearer t' }),
      deps(),
    );
    expect(p).toMatchObject({
      principal: 'user:jlapenna',
      via: 'google',
      pipelines: ['claude'],
    });
    expect(p?.scopes.has('work.operator')).toBe(true);
  });
  it('refuses an unverified email and an unknown subject', async () => {
    expect(
      await authenticateWorkRequest(
        req({ authorization: 'Bearer t' }),
        deps({
          verifyGoogleIdToken: async () => ({
            email: 'sa@example.iam.gserviceaccount.com',
            emailVerified: false,
          }),
        }),
      ),
    ).toBeUndefined();
    expect(
      await authenticateWorkRequest(
        req({ authorization: 'Bearer t' }),
        deps({
          verifyGoogleIdToken: async () => ({
            email: 'other@x.io',
            emailVerified: true,
          }),
        }),
      ),
    ).toBeUndefined();
  });
  it('refuses a Google token without a verified email', async () => {
    expect(
      await authenticateWorkRequest(
        req({ authorization: 'Bearer t' }),
        deps({
          verifyGoogleIdToken: async () => ({
            email: '',
            emailVerified: false,
          }),
        }),
      ),
    ).toBeUndefined();
  });
  it('returns undefined when the token fails verification', async () => {
    expect(
      await authenticateWorkRequest(
        req({ authorization: 'Bearer bad' }),
        deps({
          verifyGoogleIdToken: async () => {
            throw new Error('bad');
          },
        }),
      ),
    ).toBeUndefined();
  });
  it('maps an Auth.js session to github:<login>', async () => {
    const p = await authenticateWorkRequest(
      req(),
      deps({ session: async () => ({ user: { login: 'jlapenna' } }) }),
    );
    expect(p).toMatchObject({
      principal: 'user:jlapenna',
      via: 'session',
      subject: 'github:jlapenna',
    });
  });
  it('a bearer header wins over a session and never falls back to it', async () => {
    const p = await authenticateWorkRequest(
      req({ authorization: 'Bearer t' }),
      deps({
        verifyGoogleIdToken: async () => {
          throw new Error('bad');
        },
        session: async () => ({ user: { login: 'jlapenna' } }),
      }),
    );
    expect(p).toBeUndefined();
  });
  it('falls through to the session-pin-tick verifier when the bearer is not a Google token', async () => {
    const p = await authenticateWorkRequest(
      req({ authorization: 'Bearer t' }),
      deps({
        verifyGoogleIdToken: async () => {
          throw new Error('not Google');
        },
        verifySessionPinTickOidcToken: async () => ({ ok: true }),
      }),
    );
    expect(p).toMatchObject({
      principal: 'pin:tick',
      subject: 'pin:tick',
      via: 'oidc',
    });
    expect(p?.scopes.has('work.reaper')).toBe(true);
  });
  it('maps a verified GitHub Actions identity through its ordinary Work grant', async () => {
    const oidcGrants = parseWorkGrants(
      JSON.stringify([
        {
          principal: 'workflow:member-automation',
          subjects: ['github-actions:other-org/other-repo'],
          pipelines: ['claude', 'codex', 'opencode'],
        },
      ]),
    );
    const p = await authenticateWorkRequest(
      req({ authorization: 'Bearer t' }),
      deps({
        verifyGoogleIdToken: async () => {
          throw new Error('not Google');
        },
        verifyGithubActionsWorkOidcToken: async () => ({
          repository: 'other-org/other-repo',
          subject: 'github-actions:other-org/other-repo',
        }),
        grants: () => oidcGrants,
      }),
    );
    expect(p).toMatchObject({
      principal: 'workflow:member-automation',
      subject: 'github-actions:other-org/other-repo',
      sourceRepository: 'other-org/other-repo',
      via: 'oidc',
    });
    expect(p?.scopes.has('work.operator')).toBe(true);
  });
  it('refuses a bearer no verifier accepts', async () => {
    const p = await authenticateWorkRequest(
      req({ authorization: 'Bearer t' }),
      deps({
        verifyGoogleIdToken: async () => {
          throw new Error('not Google');
        },
        verifySessionPinTickOidcToken: async () => {
          throw new Error('not session-pin-tick either');
        },
        verifyGithubActionsWorkOidcToken: async () => {
          throw new Error('not Work API OIDC either');
        },
      }),
    );
    expect(p).toBeUndefined();
  });
  it('an operator bearer does not satisfy work.cron', async () => {
    const p = await authenticateWorkRequest(
      req({ authorization: 'Bearer t' }),
      deps(),
    );
    expect(p?.scopes.has('work.cron')).toBe(false);
  });
  it('a cron-scoped Google principal does not satisfy work.operator', async () => {
    const cronGrants = parseWorkGrants(
      JSON.stringify([
        {
          principal: 'svc:telemetry-writer',
          subjects: ['telemetry-writer@agent-lcars.iam.gserviceaccount.com'],
          pipelines: ['claude', 'codex', 'opencode'],
          scopes: ['work.cron'],
        },
      ]),
    );
    const p = await authenticateWorkRequest(
      req({ authorization: 'Bearer t' }),
      deps({
        verifyGoogleIdToken: async () => ({
          email: 'telemetry-writer@agent-lcars.iam.gserviceaccount.com',
          emailVerified: true,
        }),
        grants: () => cronGrants,
      }),
    );
    expect(p?.scopes.has('work.cron')).toBe(true);
    expect(p?.scopes.has('work.operator')).toBe(false);
  });
  it('maps a grant with an explicit scopes list onto the principal', async () => {
    const executorGrants = parseWorkGrants(
      JSON.stringify([
        {
          principal: 'svc:telemetry-writer',
          subjects: ['telemetry-writer@agent-lcars.iam.gserviceaccount.com'],
          pipelines: ['claude'],
          scopes: ['work.executor'],
        },
      ]),
    );
    const principal = await authenticateWorkRequest(
      req({ authorization: 'Bearer tok' }),
      deps({
        verifyGoogleIdToken: async () => ({
          email: 'telemetry-writer@agent-lcars.iam.gserviceaccount.com',
          emailVerified: true,
        }),
        grants: () => executorGrants,
      }),
    );
    expect(principal?.scopes.has('work.executor')).toBe(true);
    expect(principal?.scopes.has('work.operator')).toBe(false);
  });
});
