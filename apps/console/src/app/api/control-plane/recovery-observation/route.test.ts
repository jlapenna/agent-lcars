import {
  buildRecoveryObservation,
  type RecoveryObservation,
} from '@agent-lcars/dispatch-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  controlPlaneRepository,
  verifyRecoveryObservationOidcToken,
  recordHostedRecoveryObservation,
} = vi.hoisted(() => ({
  controlPlaneRepository: vi.fn(),
  verifyRecoveryObservationOidcToken: vi.fn(),
  recordHostedRecoveryObservation: vi.fn(),
}));

vi.mock('@/lib/deployment', () => ({ controlPlaneRepository }));
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

const identity = {
  repository: 'jlapenna/agent-lcars',
  repositoryId: 1_307_149_765,
  runId: 93_099_054_125,
};
const body: RecoveryObservation = buildRecoveryObservation({
  target: {
    domain: 'ci_retry',
    repositoryId: identity.repositoryId,
    repository: identity.repository,
    anchor: 736,
    exactIdentity: 'run:93099054125:1',
  },
  sourceKind: 'webhook',
  observedAt: '2026-08-14T00:00:00.000Z',
  evidence: 'https://github.example.test/runs/93099054125',
});

function request(
  token?: string,
  requestBody: unknown = body,
  raw = false,
): Request {
  return new Request(
    'https://console.test/api/control-plane/recovery-observation',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: raw ? String(requestBody) : JSON.stringify(requestBody),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  controlPlaneRepository.mockReturnValue('jlapenna/agent-lcars');
  verifyRecoveryObservationOidcToken.mockResolvedValue(identity);
  recordHostedRecoveryObservation.mockResolvedValue({
    operationKey: body.operationKey,
    status: 'recorded',
  });
});

describe('POST /api/control-plane/recovery-observation', () => {
  it('rejects missing authentication before the storage boundary', async () => {
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(recordHostedRecoveryObservation).not.toHaveBeenCalled();
  });

  it('records a strictly parsed observation under verified authority', async () => {
    const response = await POST(request('signed-token'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(verifyRecoveryObservationOidcToken).toHaveBeenCalledWith(
      'signed-token',
      identity.repository,
    );
    expect(recordHostedRecoveryObservation).toHaveBeenCalledWith({
      identity,
      body,
    });
  });

  it.each([
    ['malformed JSON', '{', true],
    ['an extra field', { ...body, attacker: true }, false],
    [
      'a cross-repository target',
      {
        ...body,
        target: { ...body.target, repository: 'attacker/fork' },
      },
      false,
    ],
    [
      'a forged repository ID',
      {
        ...body,
        target: { ...body.target, repositoryId: identity.repositoryId + 1 },
      },
      false,
    ],
  ])('rejects %s before invoking storage', async (_label, requestBody, raw) => {
    const response = await POST(request('signed-token', requestBody, raw));
    expect(response.status).toBe(400);
    expect(recordHostedRecoveryObservation).not.toHaveBeenCalled();
  });

  it('preserves the controller input-error status', async () => {
    recordHostedRecoveryObservation.mockRejectedValue(
      new HostedRecoveryObservationInputError('invalid'),
    );
    const response = await POST(request('signed-token'));
    expect(response.status).toBe(400);
  });

  it('preserves the transient failure status', async () => {
    recordHostedRecoveryObservation.mockRejectedValue(new Error('offline'));
    const response = await POST(request('signed-token'));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Hosted recovery observation failed',
    });
  });
});
