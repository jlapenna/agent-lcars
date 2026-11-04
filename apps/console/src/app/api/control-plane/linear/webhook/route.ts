import { logger } from '@agent-lcars/logging';
import { required } from '@agent-lcars/util-server';

import { enqueueLinearWebhook } from '@/lib/hosted-webhook-queue';
import { linearConfig } from '@/lib/linear-config';
import {
  linearWebhookEnvelopeSchema,
  verifyLinearSignature,
} from '@/lib/linear-intake';

export async function POST(request: Request): Promise<Response> {
  const respond = (body: Record<string, unknown>, status: number) =>
    Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  try {
    const config = linearConfig();
    if (config === undefined)
      return respond({ error: 'Linear integration is disabled' }, 503);
    const rawBody = Buffer.from(await request.arrayBuffer());
    if (rawBody.length > 512 * 1024)
      return respond({ error: 'Linear webhook exceeds 512 KiB' }, 413);
    if (
      !verifyLinearSignature(
        rawBody,
        request.headers.get('linear-signature'),
        required('AGENT_LCARS_LINEAR_WEBHOOK_SECRET'),
      )
    )
      return respond({ error: 'Unauthorized' }, 401);
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return respond({ error: 'Malformed JSON' }, 400);
    }
    const envelope = linearWebhookEnvelopeSchema.safeParse(json);
    if (!envelope.success)
      return respond({ error: 'Malformed Linear event' }, 400);
    if (Math.abs(Date.now() - envelope.data.webhookTimestamp) > 60_000)
      return respond({ error: 'Stale Linear event' }, 401);
    if (
      envelope.data.organizationId !== config.organizationId ||
      !['Issue', 'Comment'].includes(envelope.data.type)
    )
      return respond({ outcome: 'ignored' }, 200);
    return respond(
      await enqueueLinearWebhook(
        rawBody,
        request.headers.get('linear-signature') as string,
      ),
      200,
    );
  } catch (error) {
    logger.error('agent-lcars: Linear admission failed', error);
    return respond({ error: 'Linear admission failed' }, 500);
  }
}
