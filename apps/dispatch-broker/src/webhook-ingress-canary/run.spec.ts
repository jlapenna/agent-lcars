import crypto from 'node:crypto';

import {
  WEBHOOK_INGRESS_CANARY_MARKER,
  WEBHOOK_INGRESS_CANARY_TITLE,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import {
  assertSentinelSafe,
  classifyDeliveryFailure,
  createAppJwt,
  deliveryMatchesProbe,
} from './run.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const privatePem = privateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();

describe('real GitHub App webhook ingress canary', () => {
  it('uses a short-lived App JWT to inspect delivery history', () => {
    const now = Date.parse('2026-08-08T12:00:00.000Z');
    const token = createAppJwt('Iv1.client', privatePem, now);
    const [header, payload, signature] = token.split('.');

    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
      iss: 'Iv1.client',
      iat: Math.floor(now / 1_000) - 60,
      exp: Math.floor(now / 1_000) + 540,
    });
    expect(
      crypto.verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  it('refuses to operate if the sentinel can dispatch an agent or review', () => {
    const sentinel = {
      number: 797,
      title: WEBHOOK_INGRESS_CANARY_TITLE,
      body: WEBHOOK_INGRESS_CANARY_MARKER,
      state: 'open' as const,
      updated_at: '2026-08-08T12:00:00.000Z',
      labels: [] as Array<{ name: string }>,
    };
    expect(() => assertSentinelSafe(sentinel)).not.toThrow();
    expect(() =>
      assertSentinelSafe({
        ...sentinel,
        labels: [{ name: 'agent:codex' }],
      }),
    ).toThrow('forbidden dispatch label');
  });

  it('matches a delivery by repository, issue, action, and exact issue revision', () => {
    const detail = {
      id: 1,
      guid: '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820',
      delivered_at: '2026-08-08T12:00:01.000Z',
      event: 'issues',
      action: 'closed',
      repository_id: 1_307_149_765,
      status_code: 202,
      request: {
        payload: {
          action: 'closed',
          repository: {
            id: 1_307_149_765,
            full_name: 'jlapenna/agent-lcars',
          },
          issue: {
            number: 797,
            updated_at: '2026-08-08T12:00:00.000Z',
          },
        },
      },
    };
    expect(
      deliveryMatchesProbe(
        detail,
        'jlapenna/agent-lcars',
        1_307_149_765,
        797,
        'closed',
        '2026-08-08T12:00:00.000Z',
      ),
    ).toBe(true);
    expect(
      deliveryMatchesProbe(
        detail,
        'jlapenna/agent-lcars',
        1_307_149_765,
        798,
        'closed',
        '2026-08-08T12:00:00.000Z',
      ),
    ).toBe(false);
  });

  it('separates enqueue failure from HMAC and generic delivery rejection', () => {
    const base = {
      id: 1,
      guid: '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820',
      delivered_at: '2026-08-08T12:00:01.000Z',
      event: 'issues',
      action: 'closed',
      repository_id: 1_307_149_765,
    };
    expect(
      classifyDeliveryFailure({
        ...base,
        status_code: 500,
        response: { payload: { error: 'Hosted admission enqueue failed' } },
      })?.category,
    ).toBe('enqueue_failure');
    expect(
      classifyDeliveryFailure({ ...base, status_code: 401 })?.category,
    ).toBe('delivery_hmac_rejected');
    expect(
      classifyDeliveryFailure({ ...base, status_code: 503 })?.category,
    ).toBe('delivery_rejected');
    expect(
      classifyDeliveryFailure({ ...base, status_code: 202 }),
    ).toBeUndefined();
    expect(
      classifyDeliveryFailure({ ...base, status_code: 302 })?.category,
    ).toBe('delivery_rejected');
  });
});
