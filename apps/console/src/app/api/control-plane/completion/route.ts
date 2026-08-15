import { NextResponse } from 'next/server';

import {
  parseHostedBearerToken,
  parseHostedCompletionRequestBody,
  parseHostedJsonBody,
} from '@/lib/control-plane-request';
import { controlPlaneRepository } from '@/lib/deployment';
import { verifyCompletionOidcToken } from '@/lib/github-actions-oidc';
import {
  completeHostedWorker,
  HostedCompletionInputError,
} from '@/lib/hosted-completion';

export async function POST(request: Request): Promise<NextResponse> {
  let identity;
  try {
    identity = await verifyCompletionOidcToken(
      parseHostedBearerToken(request.headers.get('authorization')),
      controlPlaneRepository(),
    );
  } catch (error) {
    console.warn('agent-lcars: rejected hosted completion request', error);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = parseHostedJsonBody(
      await request.text(),
      parseHostedCompletionRequestBody,
    );
  } catch {
    return NextResponse.json(
      { error: 'Invalid completion request' },
      { status: 400 },
    );
  }

  try {
    const result = await completeHostedWorker({
      identity,
      body,
    });
    console.info('agent-lcars: hosted completion processed', result);
    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof HostedCompletionInputError) {
      return NextResponse.json(
        { error: 'Invalid completion request' },
        { status: 400 },
      );
    }
    console.error('agent-lcars: hosted completion failed', error);
    return NextResponse.json(
      { error: 'Hosted completion failed' },
      { status: 500 },
    );
  }
}
