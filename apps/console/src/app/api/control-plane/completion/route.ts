import { NextResponse } from 'next/server';

import {
  parseHostedBearerToken,
  parseHostedCompletionRequestBody,
  parseHostedJsonBody,
} from '@/lib/control-plane-request';
import { controlPlaneRepositories } from '@/lib/deployment';
import { verifyCompletionOidcToken } from '@/lib/github-actions-oidc';
import { handleCompletion } from '@/lib/orchestrator-routes';
import { createOrchestratorRuntime } from '@/lib/orchestrator-runtime';

export async function POST(request: Request): Promise<NextResponse> {
  let identity;
  try {
    identity = await verifyCompletionOidcToken(
      parseHostedBearerToken(request.headers.get('authorization')),
      controlPlaneRepositories(),
    );
  } catch (error) {
    console.warn('agent-lcars: rejected hosted completion request', error);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body;
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
    const result = await handleCompletion(
      createOrchestratorRuntime(),
      body,
      identity,
    );
    console.info('agent-lcars: orchestrator completion processed', result);
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('agent-lcars: orchestrator completion failed', error);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
