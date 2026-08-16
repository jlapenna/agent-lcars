import { NextResponse } from 'next/server';

import {
  parseHostedBearerToken,
  parseHostedReconcileRequestBody,
} from '@/lib/control-plane-request';
import { controlPlaneRepository } from '@/lib/deployment';
import { verifyReconcileOidcToken } from '@/lib/github-actions-oidc';
import { handleReconcile } from '@/lib/orchestrator-routes';
import { createOrchestratorRuntime } from '@/lib/orchestrator-runtime';

export async function POST(request: Request): Promise<NextResponse> {
  // #1190: deliberately NOT `isControlPlaneRepository`/the allow-list. There
  // is exactly one reconciler: the home repo's scheduled
  // dispatch-reconcile.yml sweeps every onboarded repo's tasks from this one
  // canonical caller. Widening this to the allow-list would let any
  // onboarded repo's own reconcile workflow claim scheduler identity, which
  // is not the topology this slice establishes.
  const repository = controlPlaneRepository();
  try {
    await verifyReconcileOidcToken(
      parseHostedBearerToken(request.headers.get('authorization')),
      repository,
    );
  } catch (error) {
    console.warn('agent-lcars: rejected hosted reconcile request', error);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    parseHostedReconcileRequestBody(await request.text());
  } catch {
    return NextResponse.json(
      { error: 'Invalid reconcile request' },
      { status: 400 },
    );
  }

  try {
    const result = await handleReconcile(createOrchestratorRuntime());
    console.info('agent-lcars: orchestrator reconcile completed', result);
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('agent-lcars: orchestrator reconcile failed', error);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
