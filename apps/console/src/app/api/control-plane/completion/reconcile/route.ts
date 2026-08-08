import { required } from '@agent-lcars/util-server';
import { NextResponse } from 'next/server';

import { verifyWebhookSignature } from '@/lib/github-webhook-auth';
import {
  CompletionRunNotTerminalError,
  reconcileCompletedWorker,
} from '@/lib/hosted-completion-reconcile';

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = Buffer.from(await request.arrayBuffer());
  if (
    !verifyWebhookSignature(
      rawBody,
      request.headers.get('x-agent-lcars-signature-256'),
      required('AGENT_LCARS_WEBHOOK_SECRET'),
    )
  ) {
    console.warn(
      'agent-lcars: rejected completion reconciliation with bad signature',
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await reconcileCompletedWorker(
      JSON.parse(rawBody.toString('utf8')) as unknown,
    );
    console.info('agent-lcars: completion reconciliation processed', result);
    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof CompletionRunNotTerminalError) {
      return NextResponse.json(
        { error: 'Worker run is not terminal' },
        { status: 503, headers: { 'Retry-After': '5' } },
      );
    }
    console.error('agent-lcars: completion reconciliation failed', error);
    return NextResponse.json(
      { error: 'Completion reconciliation failed' },
      { status: 500 },
    );
  }
}
