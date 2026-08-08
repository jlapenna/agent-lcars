import 'server-only';

import crypto from 'node:crypto';

const DELIVERY_ID = /^[0-9a-f-]{1,100}$/iu;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/iu;

export function assertGitHubDeliveryId(deliveryId: string): void {
  if (!DELIVERY_ID.test(deliveryId)) {
    throw new Error('GitHub webhook delivery ID is invalid');
  }
}

export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | null,
  secret: string,
): boolean {
  const match = signatureHeader?.match(SIGNATURE);
  if (!match) return false;
  const actual = Buffer.from(match[1], 'hex');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}
