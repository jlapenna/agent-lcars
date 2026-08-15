import { NextResponse } from 'next/server';

import { controlPlaneRepository } from '@/lib/deployment';
import { verifyRecoveryObservationOidcToken } from '@/lib/github-actions-oidc';
import {
  assertHostedRecoveryObservationAuthority,
  type HostedRecoveryObservationRequestBody,
  parseHostedBearerToken,
  parseHostedJsonBody,
  parseHostedRecoveryObservationRequestBody,
} from '@/lib/hosted-lifecycle/hosted-route-contract';
import {
  HostedRecoveryObservationInputError,
  recordHostedRecoveryObservation,
} from '@/lib/hosted-recovery-observation';

export async function POST(request: Request): Promise<NextResponse> {
  let identity;
  try {
    identity = await verifyRecoveryObservationOidcToken(
      parseHostedBearerToken(request.headers.get('authorization')),
      controlPlaneRepository(),
    );
  } catch (error) {
    console.warn(
      'agent-lcars: rejected hosted recovery-observation request',
      error,
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: HostedRecoveryObservationRequestBody;
  try {
    body = parseHostedJsonBody(
      await request.text(),
      parseHostedRecoveryObservationRequestBody,
    );
    assertHostedRecoveryObservationAuthority(body, identity);
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
