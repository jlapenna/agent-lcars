import { NextResponse } from 'next/server';

import { controlPlaneRepository } from '@/lib/deployment';
import { verifyReconcileOidcToken } from '@/lib/github-actions-oidc';
import { runHostedReconcile } from '@/lib/hosted-reconciler';

function bearerToken(header: string | null): string {
  const match = header?.match(/^Bearer ([^\s]+)$/u);
  if (!match) throw new Error('A bearer token is required');
  return match[1];
}

export async function POST(request: Request): Promise<NextResponse> {
  const repository = controlPlaneRepository();
  try {
    await verifyReconcileOidcToken(
      bearerToken(request.headers.get('authorization')),
      repository,
    );
  } catch (error) {
    console.warn('agent-lcars: rejected hosted reconcile request', error);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runHostedReconcile();
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
