import { NextResponse } from 'next/server';

import { controlPlaneRepository } from '@/lib/deployment';
import { verifyAnchorProjectionBackfillOidcToken } from '@/lib/github-actions-oidc';
import {
  AnchorProjectionBackfillLimitError,
  reconcileCurrentGithubAnchorProjections,
} from '@/lib/github-anchor-reconcile';

function bearerToken(authorization: string | null): string {
  const match = authorization?.match(/^Bearer\s+(.+)$/iu);
  if (match?.[1] === undefined) throw new Error('missing bearer token');
  return match[1];
}

/**
 * A manual, OIDC-pinned cutover endpoint. It is intentionally separate from
 * the recurring Run reconciler so a GitHub listing can never become normal
 * queue-render traffic or an unattended compatibility mechanism.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const repository = controlPlaneRepository();
  try {
    await verifyAnchorProjectionBackfillOidcToken(
      bearerToken(request.headers.get('authorization')),
      repository,
    );
  } catch (error) {
    console.warn('agent-lcars: rejected anchor projection backfill', error);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    if ((await request.text()).length > 0) {
      throw new Error('expected an empty request body');
    }
  } catch {
    return NextResponse.json(
      { error: 'Invalid projection backfill request' },
      { status: 400 },
    );
  }

  try {
    const result = await reconcileCurrentGithubAnchorProjections();
    console.info('agent-lcars: anchor projection backfill completed', result);
    if (result.comparison !== undefined && !result.comparison.matches) {
      return NextResponse.json(
        { error: 'Queue projection mismatch', result },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof AnchorProjectionBackfillLimitError) {
      console.error(
        'agent-lcars: anchor projection backfill incomplete',
        error,
      );
      return NextResponse.json(
        { error: 'Incomplete backfill' },
        { status: 409 },
      );
    }
    console.error('agent-lcars: anchor projection backfill failed', error);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
