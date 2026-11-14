import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { describeRefusedOperatorToken } from './operator-token-check';

const TOKEN = 'gho_refusedtokenvalue';

function stubGithub(response: Response | Error) {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('describeRefusedOperatorToken', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_GITHUB_ID', 'client-id');
    vi.stubEnv('AUTH_GITHUB_SECRET', 'client-secret');
    vi.stubEnv('AGENT_CONSOLE_GITHUB_API_BASE_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reports a token GitHub still lists, with its record's dates", async () => {
    const fetchMock = stubGithub(
      Response.json({
        token: TOKEN,
        created_at: '2026-11-11T19:00:52Z',
        expires_at: null,
      }),
    );

    await expect(describeRefusedOperatorToken(TOKEN)).resolves.toEqual({
      tokenRecord: 'present',
      tokenRecordCreatedAt: '2026-11-11T19:00:52Z',
      tokenRecordExpiresAt: null,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.github.com/applications/client-id/token');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['authorization']).toBe(
      `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
    );
    expect(JSON.parse(init.body as string)).toEqual({ access_token: TOKEN });
  });

  it('never returns the token itself', async () => {
    stubGithub(Response.json({ token: TOKEN, created_at: 'x' }));

    const record = await describeRefusedOperatorToken(TOKEN);

    expect(JSON.stringify(record)).not.toContain(TOKEN);
  });

  it('reports a token GitHub no longer holds', async () => {
    stubGithub(new Response('{}', { status: 404 }));

    await expect(describeRefusedOperatorToken(TOKEN)).resolves.toEqual({
      tokenRecord: 'absent',
    });
  });

  it.each([422, 503])(
    'reports no verdict when GitHub answers HTTP %i',
    async (status) => {
      stubGithub(new Response('{}', { status }));

      await expect(describeRefusedOperatorToken(TOKEN)).resolves.toEqual({
        tokenRecord: 'unknown',
      });
    },
  );

  it('reports no verdict when GitHub cannot be reached', async () => {
    stubGithub(new Error('network down'));

    await expect(describeRefusedOperatorToken(TOKEN)).resolves.toEqual({
      tokenRecord: 'unknown',
    });
  });

  it('asks nothing without sign-in app credentials or under the E2E fixture API', async () => {
    const fetchMock = stubGithub(Response.json({}));

    vi.stubEnv('AUTH_GITHUB_SECRET', '');
    await expect(describeRefusedOperatorToken(TOKEN)).resolves.toBeUndefined();

    vi.stubEnv('AUTH_GITHUB_SECRET', 'client-secret');
    vi.stubEnv('AGENT_CONSOLE_GITHUB_API_BASE_URL', 'http://localhost:1');
    await expect(describeRefusedOperatorToken(TOKEN)).resolves.toBeUndefined();

    await expect(describeRefusedOperatorToken('')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
