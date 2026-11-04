import { afterEach, expect, it, vi } from 'vitest';

import {
  jobGithubCredentialSources,
  resolveJobGithubCredential,
} from './job-github-credentials';

const now = new Date('2026-11-04T00:00:00Z');
const value = {
  token: 'fixture-personal-token',
  expiresAt: '2026-11-05T00:00:00Z',
};
function ports() {
  return {
    sources: {
      personal: {
        login: 'jlapenna',
        secretVersion: 'projects/example/secrets/personal/versions/latest',
      },
    },
    readSecret: vi.fn(async () => JSON.stringify(value)),
    readLogin: vi.fn(async () => 'jlapenna'),
  };
}
afterEach(() => vi.unstubAllEnvs());
it('resolves only the selected secret and verifies the GitHub identity', async () => {
  const p = ports();
  expect(await resolveJobGithubCredential('personal', now, p)).toEqual({
    ...value,
    login: 'jlapenna',
    refreshAt: '2026-11-04T00:05:00.000Z',
  });
  expect(p.readSecret).toHaveBeenCalledExactlyOnceWith(
    p.sources.personal.secretVersion,
  );
  expect(p.readLogin).toHaveBeenCalledExactlyOnceWith(value.token);
  p.readSecret.mockResolvedValue(
    JSON.stringify({ ...value, token: 'rotated-fixture' }),
  );
  expect((await resolveJobGithubCredential('personal', now, p)).token).toBe(
    'rotated-fixture',
  );
});
it('does not fall back for an unconfigured identity', async () => {
  const p = ports();
  await expect(resolveJobGithubCredential('missing', now, p)).rejects.toThrow(
    'not configured',
  );
  expect(p.readSecret).not.toHaveBeenCalled();
});
it.each(['expired', 'wrong-user', 'malformed', 'access-denied'])(
  'refuses %s without exposing authenticated errors or payloads',
  async (failure) => {
    const p = ports();
    if (failure === 'expired')
      p.readSecret.mockResolvedValue(
        JSON.stringify({ ...value, expiresAt: now.toISOString() }),
      );
    if (failure === 'wrong-user') p.readLogin.mockResolvedValue('other-user');
    if (failure === 'malformed') p.readSecret.mockResolvedValue(value.token);
    if (failure === 'access-denied')
      p.readSecret.mockRejectedValue(
        new Error(`Authorization: Bearer ${value.token}`),
      );
    const error = await resolveJobGithubCredential('personal', now, p).catch(
      (reason: Error) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(
      'unavailable, expired, or has the wrong identity',
    );
    expect(String(error)).not.toContain(value.token);
    expect(p.readLogin).toHaveBeenCalledTimes(failure === 'wrong-user' ? 1 : 0);
  },
);
it('rejects arbitrary URLs and malformed configuration before credential IO', () => {
  vi.stubEnv(
    'AGENT_LCARS_JOB_GITHUB_CREDENTIALS',
    JSON.stringify({
      personal: {
        login: 'jlapenna',
        secretVersion: 'https://attacker.example/secret',
      },
    }),
  );
  expect(() => jobGithubCredentialSources()).toThrow(
    'Invalid AGENT_LCARS_JOB_GITHUB_CREDENTIALS',
  );
});

it('periodically revalidates an explicitly non-expiring OAuth credential', async () => {
  const p = ports();
  p.readSecret.mockResolvedValue(
    JSON.stringify({ token: value.token, expiresAt: null }),
  );
  expect(await resolveJobGithubCredential('personal', now, p)).toMatchObject({
    expiresAt: null,
    refreshAt: '2026-11-04T00:05:00.000Z',
  });
});
