import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertGitHubDeliveryId,
  verifyWebhookSignature,
} from './github-webhook-auth';

describe('GitHub webhook authentication', () => {
  it('accepts GitHub delivery UUIDs and rejects unsafe task identifiers', () => {
    expect(() =>
      assertGitHubDeliveryId('4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820'),
    ).not.toThrow();
    expect(() => assertGitHubDeliveryId('../delivery')).toThrow(
      'delivery ID is invalid',
    );
    expect(() => assertGitHubDeliveryId('')).toThrow('delivery ID is invalid');
  });

  it('verifies the raw request bytes with GitHub HMAC-SHA256 framing', () => {
    const body = '{"zen":"Approachable is better than simple."}';
    const secret = 'test-webhook-secret';
    const signature = `sha256=${crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex')}`;

    expect(verifyWebhookSignature(Buffer.from(body), signature, secret)).toBe(
      true,
    );
    expect(
      verifyWebhookSignature(Buffer.from(`${body}\n`), signature, secret),
    ).toBe(false);
    expect(
      verifyWebhookSignature(Buffer.from(body), 'sha256=bad', secret),
    ).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(body), null, secret)).toBe(false);
  });
});
