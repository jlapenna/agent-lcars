import { logger } from '@agent-lcars/logging';
import { required } from '@agent-lcars/util-server';
import { after } from 'next/server';

import { linearConfig } from '@/lib/linear-config';
import { admitLinearWebhook, verifyLinearSignature } from '@/lib/linear-intake';
import { createOrchestratorRuntime } from '@/lib/orchestrator-runtime';

export async function POST(request: Request): Promise<Response> {
  const respond = (body: Record<string, unknown>, status: number) =>
    Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  try {
    const config = linearConfig();
    if (config === undefined)
      return respond({ error: 'Linear integration is disabled' }, 503);
    const rawBody = Buffer.from(await request.arrayBuffer());
    if (
      !verifyLinearSignature(
        rawBody,
        request.headers.get('linear-signature'),
        required('AGENT_LCARS_LINEAR_WEBHOOK_SECRET'),
      )
    )
      return respond({ error: 'Unauthorized' }, 401);
    const runtime = createOrchestratorRuntime();
    const result = await admitLinearWebhook(rawBody, config, runtime);
    if (result.body['itemId'] !== undefined)
      after(async () => {
        try {
          await runtime.drain();
        } catch (error) {
          logger.error(
            'agent-lcars: Linear post-admission drain failed; durable outbox will retry',
            error,
          );
        }
      });
    return respond(result.body, result.status);
  } catch (error) {
    logger.error('agent-lcars: Linear admission failed', error);
    return respond({ error: 'Linear admission failed' }, 500);
  }
}
