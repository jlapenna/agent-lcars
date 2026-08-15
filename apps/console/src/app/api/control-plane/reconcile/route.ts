import { NextResponse } from 'next/server';

import { controlPlaneRepository } from '@/lib/deployment';
import { verifyReconcileOidcToken } from '@/lib/github-actions-oidc';
import {
  parseHostedBearerToken,
  parseHostedReconcileRequestBody,
} from '@/lib/hosted-lifecycle/hosted-route-contract';
import { runHostedReconcile } from '@/lib/hosted-reconciler';

export async function POST(request: Request): Promise<NextResponse> {
  const repository = controlPlaneRepository();
  let identity;
  try {
    identity = await verifyReconcileOidcToken(
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
    const result = await runHostedReconcile(identity);
    console.info('agent-lcars: hosted reconcile scan completed', result);
    return NextResponse.json(result, {
      status: result.failed.length > 0 ? 502 : 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('agent-lcars: hosted reconcile scan failed', error);
    return NextResponse.json(
      { error: 'Reconcile scan failed' },
      { status: 500 },
    );
  }
}
