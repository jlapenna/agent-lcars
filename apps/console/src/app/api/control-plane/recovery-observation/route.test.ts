import { buildRecoveryObservation } from '@agent-lcars/dispatch-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyRecoveryObservationOidcToken, recordHostedRecoveryObservation } =
  vi.hoisted(() => ({
    verifyRecoveryObservationOidcToken: vi.fn(),
    recordHostedRecoveryObservation: vi.fn(),
  }));

vi.mock('@/lib/github-actions-oidc', () => ({
  verifyRecoveryObservationOidcToken,
}));
vi.mock('@/lib/hosted-recovery-observation', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/lib/hosted-recovery-observation')
  >()),
  recordHostedRecoveryObservation,
}));

import { HostedRecoveryObservationInputError } from '@/lib/hosted-recovery-observation';

import { POST } from './route';

const observation = buildRecoveryObservation({
  target: {
    domain: 'ci_retry',
    repositoryId: 1_307_149_765,
    repository: 'jlapenna/agent-lcars',
    anchor: 42,
    exactIdentity: 'run:1:1',
  },
  sourceKind: 'webhook',
  observedAt: '2026-08-09T00:00:00.000Z',
  evidence: 'https://example.invalid/evidence',
});
const identity = {
  repository: 'jlapenna/agent-lcars',
  repositoryId: 1_307_149_765,
  runId: 93_099_054_125,
};

function request(token?: string, body: unknown = observation): Request {
  return new Request(
    'https://console.test/api/control-plane/recovery-observation',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyRecoveryObservationOidcToken.mockResolvedValue(identity);
  recordHostedRecoveryObservation.mockResolvedValue({
    operationKey: observation.operationKey,
    observation,
    recordedAt: '2026-08-09T00:00:00.000Z',
    status: 'pending',
  });
});

describe('POST /api/control-plane/recovery-observation', () => {
  it('rejects a request without a GitHub Actions OIDC bearer token', async () => {
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(recordHostedRecoveryObservation).not.toHaveBeenCalled();
  });

  it('records an observation under the signed identity', async () => {
    const response = await POST(request('signed-token'));
    expect(response.status).toBe(200);
    expect(verifyRecoveryObservationOidcToken).toHaveBeenCalledWith(
      'signed-token',
      'jlapenna/agent-lcars',
    );
    expect(recordHostedRecoveryObservation).toHaveBeenCalledWith({
      identity,
      body: observation,
    });
  });

  it('rejects an invalid observation without a retryable response', async () => {
    recordHostedRecoveryObservation.mockRejectedValue(
      new HostedRecoveryObservationInputError('bad observation'),
    );
    const response = await POST(request('signed-token'));
    expect(response.status).toBe(400);
  });

  it('rejects malformed JSON before recording anything', async () => {
    const response = await POST(
      new Request(
        'https://console.test/api/control-plane/recovery-observation',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer signed-token' },
          body: '{',
        },
      ),
    );
    expect(response.status).toBe(400);
    expect(recordHostedRecoveryObservation).not.toHaveBeenCalled();
  });

  it('does not record when OIDC claims fail', async () => {
    verifyRecoveryObservationOidcToken.mockRejectedValue(
      new Error('wrong repository'),
    );
    const response = await POST(request('wrong-token'));
    expect(response.status).toBe(401);
    expect(recordHostedRecoveryObservation).not.toHaveBeenCalled();
  });

  it('returns 500 for an unexpected storage failure', async () => {
    recordHostedRecoveryObservation.mockRejectedValue(new Error('boom'));
    const response = await POST(request('signed-token'));
    expect(response.status).toBe(500);
  });
});
