import { NextResponse } from 'next/server';

import {
  parseHostedBearerToken,
  parseHostedDispatchRequestBody,
  parseHostedJsonBody,
} from '@/lib/control-plane-request';
import { controlPlaneRepositories } from '@/lib/deployment';
import {
  type RequestOidcIdentity,
  verifyRequestOidcToken,
} from '@/lib/github-actions-oidc';
import { handleDispatchRequest } from '@/lib/orchestrator-routes';
import { createOrchestratorRuntime } from '@/lib/orchestrator-runtime';

export async function POST(request: Request): Promise<NextResponse> {
  let identity: RequestOidcIdentity;
  try {
    identity = await verifyRequestOidcToken(
      parseHostedBearerToken(request.headers.get('authorization')),
      controlPlaneRepositories(),
    );
  } catch (error) {
    console.warn('agent-lcars: rejected hosted dispatch request', error);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try {
    body = parseHostedJsonBody(
      await request.text(),
      parseHostedDispatchRequestBody,
    );
  } catch {
    return NextResponse.json(
      { error: 'Invalid dispatch request' },
      { status: 400 },
    );
  }

  try {
    const result = await handleDispatchRequest(createOrchestratorRuntime(), {
      repository: identity.repository,
      callerRunId: identity.runId,
      body,
    });
    console.info(
      'agent-lcars: orchestrator dispatch request processed',
      result,
    );
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('agent-lcars: orchestrator dispatch request failed', error);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
