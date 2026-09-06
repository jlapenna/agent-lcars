// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const { getIdTokenClient } = vi.hoisted(() => ({
  getIdTokenClient: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getIdTokenClient = getIdTokenClient;
  },
}));

import {
  deliverOutcomeWebhook,
  outcomeWebhookFor,
  type OutcomeWebhookPayload,
} from './outcome-webhook';

afterEach(() => {
  delete process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'];
  vi.unstubAllGlobals();
  getIdTokenClient.mockReset();
});

describe('outcomeWebhookFor', () => {
  it('returns the configured target for a channel', () => {
    process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'] = JSON.stringify({
      slack: {
        url: 'https://bot.example/outcome',
        audience: 'sprinkles-lcars-bot',
      },
    });

    expect(outcomeWebhookFor('slack')).toEqual({
      url: 'https://bot.example/outcome',
      audience: 'sprinkles-lcars-bot',
    });
  });

  it('returns undefined for a channel with no configured target', () => {
    process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'] = JSON.stringify({
      slack: { url: 'https://bot.example/outcome', audience: 'aud' },
    });

    expect(outcomeWebhookFor('github')).toBeUndefined();
  });

  it('returns undefined when the variable is absent', () => {
    delete process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'];

    expect(outcomeWebhookFor('slack')).toBeUndefined();
  });

  it('returns undefined for malformed JSON rather than throwing', () => {
    process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'] = '{not valid json';

    expect(() => outcomeWebhookFor('slack')).not.toThrow();
    expect(outcomeWebhookFor('slack')).toBeUndefined();
  });

  it('returns undefined when the configured value is not a JSON object', () => {
    process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'] = JSON.stringify([
      'not',
      'an',
      'object',
    ]);

    expect(outcomeWebhookFor('slack')).toBeUndefined();
  });

  it('returns undefined when a channel entry is missing url or audience', () => {
    process.env['AGENT_LCARS_OUTCOME_WEBHOOKS'] = JSON.stringify({
      slack: { url: 'https://bot.example/outcome' },
    });

    expect(outcomeWebhookFor('slack')).toBeUndefined();
  });
});

describe('deliverOutcomeWebhook', () => {
  const target = { url: 'https://bot.example/outcome', audience: 'aud' };
  const payload: OutcomeWebhookPayload = {
    itemId: '01J5Z3K9QX8F0N2B4V6C8D1E4H',
    runId: 'work:01J5Z3K9QX8F0N2B4V6C8D1E4H/r1',
    state: 'finished',
    ok: true,
    parked: true,
    message: 'Which database should I use?',
    thread: 'T0123/C0456/1788673935.123456',
    consoleUrl: 'https://lcars.jlapenna.net/work/01J5Z3K9QX8F0N2B4V6C8D1E4H',
  };

  it('mints an ID token for the target audience and POSTs the signed payload', async () => {
    getIdTokenClient.mockResolvedValue({
      getRequestHeaders: async () =>
        new Headers({ Authorization: 'Bearer test-id-token' }),
    });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);

    await deliverOutcomeWebhook(target, payload);

    expect(getIdTokenClient).toHaveBeenCalledWith('aud');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(target.url);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(payload);
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-id-token');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('throws on a non-2xx response', async () => {
    getIdTokenClient.mockResolvedValue({
      getRequestHeaders: async () => new Headers(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 500 })),
    );

    await expect(deliverOutcomeWebhook(target, payload)).rejects.toThrow('500');
  });
});
