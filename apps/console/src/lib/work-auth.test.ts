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
});
