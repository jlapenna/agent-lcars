import { NextResponse } from 'next/server';

import { controlPlaneRepository } from '@/lib/deployment';
import { verifyWebhookIngressCanaryOidcToken } from '@/lib/github-actions-oidc';
import {
  inspectWebhookIngressProbe,
  type WebhookIngressProbeRequest,
} from '@/lib/webhook-ingress-probe';

function bearerToken(header: string | null): string {
  const match = header?.match(/^Bearer ([^\s]+)$/u);
  if (!match) throw new Error('A bearer token is required');
  return match[1];
}

export async function POST(request: Request): Promise<NextResponse> {
  const repository = controlPlaneRepository();
  let identity;
  try {
    identity = await verifyWebhookIngressCanaryOidcToken(
      bearerToken(request.headers.get('authorization')),
      repository,
    );
  } catch (error) {
    console.warn('agent-lcars: rejected webhook ingress probe request', error);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await inspectWebhookIngressProbe({
      identity,
      request: (await request.json()) as WebhookIngressProbeRequest,
    });
    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('agent-lcars: webhook ingress probe failed', error);
    return NextResponse.json(
      { error: 'Webhook ingress probe failed' },
      { status: 400 },
    );
  }
}
