// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  refreshGithubUserToken,
  resetGithubTokenRefreshForTests,
} from './github-token-refresh';

const NOW = Date.parse('2026-11-14T12:00:00Z');

function stubGithub(...responses: (Response | Error)[]) {
  const fetchMock = vi.fn(async () => {
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return next!.clone();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('refreshGithubUserToken', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(NOW) });
    vi.stubEnv('AUTH_GITHUB_ID', 'client-id');
    vi.stubEnv('AUTH_GITHUB_SECRET', 'client-secret');
    vi.stubEnv('AGENT_CONSOLE_GITHUB_API_BASE_URL', '');
    resetGithubTokenRefreshForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('exchanges the refresh token as the sign-in app and returns the rotated pair', async () => {
    const fetchMock = stubGithub(
      Response.json({
        access_token: 'access-2',
        expires_in: 28_800,
        refresh_token: 'refresh-2',
        refresh_token_expires_in: 15_897_600,
      }),
    );

    await expect(refreshGithubUserToken('refresh-1')).resolves.toEqual({
      ok: true,
      accessToken: 'access-2',
      accessTokenExpiresAt: NOW + 28_800_000,
      refreshToken: 'refresh-2',
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://github.com/login/oauth/access_token');
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: 'client-id',
      client_secret: 'client-secret',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
    });
  });

  it("reports GitHub's refusal, which arrives as HTTP 200 with an error code", async () => {
    stubGithub(
      Response.json({
        error: 'bad_refresh_token',
        error_description: 'The refresh token passed is incorrect or expired.',
      }),
    );

    await expect(refreshGithubUserToken('refresh-1')).resolves.toEqual({
      ok: false,
      outcome: 'refused',
      githubError: 'bad_refresh_token',
    });
  });

  it('reports a failure when GitHub does not answer', async () => {
    stubGithub(new Response('oops', { status: 503 }));
    await expect(refreshGithubUserToken('refresh-1')).resolves.toEqual({
      ok: false,
      outcome: 'failed',
    });

    stubGithub(new Error('network down'));
    await expect(refreshGithubUserToken('refresh-1')).resolves.toEqual({
      ok: false,
      outcome: 'failed',
    });
  });

  it('spends a refresh token once for requests that arrive together or just after', async () => {
    const fetchMock = stubGithub(
      Response.json({ access_token: 'access-2', refresh_token: 'refresh-2' }),
    );

    const [first, second] = await Promise.all([
      refreshGithubUserToken('refresh-1'),
      refreshGithubUserToken('refresh-1'),
    ]);
    // A request that left the browser before the renewed cookie arrived.
    vi.advanceTimersByTime(10_000);
    const late = await refreshGithubUserToken('refresh-1');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(second).toBe(first);
    expect(late).toBe(first);

    vi.advanceTimersByTime(30_000);
    await refreshGithubUserToken('refresh-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not share a failure: the next request tries again', async () => {
    const fetchMock = stubGithub(
      new Response('oops', { status: 503 }),
      Response.json({ access_token: 'access-2' }),
    );

    await expect(refreshGithubUserToken('refresh-1')).resolves.toMatchObject({
      ok: false,
    });
    await expect(refreshGithubUserToken('refresh-1')).resolves.toMatchObject({
      ok: true,
      accessToken: 'access-2',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('asks nothing without sign-in app credentials or under the E2E fixture API', async () => {
    const fetchMock = stubGithub(Response.json({}));

    vi.stubEnv('AUTH_GITHUB_SECRET', '');
    await expect(refreshGithubUserToken('refresh-1')).resolves.toBeUndefined();

    vi.stubEnv('AUTH_GITHUB_SECRET', 'client-secret');
    vi.stubEnv('AGENT_CONSOLE_GITHUB_API_BASE_URL', 'http://localhost:1');
    await expect(refreshGithubUserToken('refresh-1')).resolves.toBeUndefined();

    await expect(refreshGithubUserToken('')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
