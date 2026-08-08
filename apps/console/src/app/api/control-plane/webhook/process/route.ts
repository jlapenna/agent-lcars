import { required } from '@agent-lcars/util-server';
import { NextResponse } from 'next/server';

import { verifyWebhookSignature } from '@/lib/github-webhook-auth';
import {
  admitGitHubWebhook,
  type GitHubWebhookPayload,
} from '@/lib/hosted-admission';

function header(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim();
  if (!value) throw new Error(`${name} header is required`);
  return value;
}

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = Buffer.from(await request.arrayBuffer());
  if (
    !verifyWebhookSignature(
      rawBody,
      request.headers.get('x-hub-signature-256'),
      required('AGENT_LCARS_WEBHOOK_SECRET'),
    )
  ) {
    console.warn('agent-lcars: rejected queued webhook with bad signature');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await admitGitHubWebhook({
      deliveryId: header(request, 'x-github-delivery'),
      eventName: header(request, 'x-github-event'),
      payload: JSON.parse(rawBody.toString('utf8')) as GitHubWebhookPayload,
    });
    console.info('agent-lcars: hosted admission completed', result);
    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('agent-lcars: hosted admission failed', error);
    return NextResponse.json(
      { error: 'Hosted admission failed' },
      { status: 500 },
    );
  }
}
