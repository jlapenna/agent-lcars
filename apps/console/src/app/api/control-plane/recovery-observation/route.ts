import { NextResponse } from 'next/server';

import { controlPlaneRepository } from '@/lib/deployment';
import { verifyRecoveryObservationOidcToken } from '@/lib/github-actions-oidc';
import {
  HostedRecoveryObservationInputError,
  recordHostedRecoveryObservation,
} from '@/lib/hosted-recovery-observation';

function bearerToken(header: string | null): string {
  const match = header?.match(/^Bearer ([^\s]+)$/u);
  if (!match) throw new Error('A bearer token is required');
  return match[1];
}

export async function POST(request: Request): Promise<NextResponse> {
  let identity;
  try {
    identity = await verifyRecoveryObservationOidcToken(
      bearerToken(request.headers.get('authorization')),
      controlPlaneRepository(),
    );
  } catch (error) {
    console.warn(
      'agent-lcars: rejected hosted recovery-observation request',
      error,
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid recovery-observation request' },
      { status: 400 },
    );
  }

  try {
    const result = await recordHostedRecoveryObservation({ identity, body });
    console.info('agent-lcars: hosted recovery observation recorded', result);
    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof HostedRecoveryObservationInputError) {
      return NextResponse.json(
        { error: 'Invalid recovery-observation request' },
        { status: 400 },
      );
    }
    console.error('agent-lcars: hosted recovery observation failed', error);
    return NextResponse.json(
      { error: 'Hosted recovery observation failed' },
      { status: 500 },
    );
  }
}
