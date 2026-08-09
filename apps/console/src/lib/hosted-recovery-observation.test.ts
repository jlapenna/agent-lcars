import {
  buildRecoveryObservation,
  type RecoveryObservation,
} from '@agent-lcars/dispatch-contracts';
import { InMemoryRecoveryOperationPort } from '@agent-lcars/dispatch-controller/storage/recovery-in-memory-port';
import { describe, expect, it } from 'vitest';

import type { RecoveryObservationOidcIdentity } from './github-actions-oidc';
import {
  HostedRecoveryObservationInputError,
  recordHostedRecoveryObservation,
} from './hosted-recovery-observation';

const identity: RecoveryObservationOidcIdentity = {
  repository: 'jlapenna/agent-lcars',
  repositoryId: 1_307_149_765,
  runId: 93_099_054_125,
};

function observationFixture(
  overrides: Partial<Parameters<typeof buildRecoveryObservation>[0]> = {},
): RecoveryObservation {
  return buildRecoveryObservation({
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
    ...overrides,
  });
}

describe('recordHostedRecoveryObservation', () => {
  it('records a well-formed observation and returns it pending', async () => {
    const port = new InMemoryRecoveryOperationPort();
    const observation = observationFixture();
    const result = await recordHostedRecoveryObservation({
      identity,
      body: observation,
      portFactory: () => port,
    });
    expect(result.status).toBe('pending');
    expect(result.operationKey).toBe(observation.operationKey);
  });

  it('is idempotent for a replayed observation of the same fact', async () => {
    const port = new InMemoryRecoveryOperationPort();
    const observation = observationFixture();
    const first = await recordHostedRecoveryObservation({
      identity,
      body: observation,
      portFactory: () => port,
    });
    const second = await recordHostedRecoveryObservation({
      identity,
      body: observationFixture({ sourceKind: 'schedule' }),
      portFactory: () => port,
    });
    expect(second.recordedAt).toBe(first.recordedAt);
    expect(second.observation.sourceKind).toBe('webhook');
  });

  it('rejects a malformed body', async () => {
    const port = new InMemoryRecoveryOperationPort();
    await expect(
      recordHostedRecoveryObservation({
        identity,
        body: { not: 'an observation' },
        portFactory: () => port,
      }),
    ).rejects.toThrow(HostedRecoveryObservationInputError);
  });

  it('rejects an identity whose repository does not match the control plane', async () => {
    const port = new InMemoryRecoveryOperationPort();
    await expect(
      recordHostedRecoveryObservation({
        identity: { ...identity, repository: 'attacker/fork' },
        body: observationFixture(),
        portFactory: () => port,
      }),
    ).rejects.toThrow(HostedRecoveryObservationInputError);
  });

  it("rejects an observation whose target.repository differs from the caller's own identity", async () => {
    const port = new InMemoryRecoveryOperationPort();
    await expect(
      recordHostedRecoveryObservation({
        identity,
        body: observationFixture({
          target: {
            domain: 'ci_retry',
            repositoryId: 1,
            repository: 'supersprinklesracing/sprinkles',
            anchor: 42,
            exactIdentity: 'run:1:1',
          },
        }),
        portFactory: () => port,
      }),
    ).rejects.toThrow(HostedRecoveryObservationInputError);
  });

  it('rejects an observation whose target.repositoryId does not match the signed OIDC repository_id claim, even when the slug matches', async () => {
    const port = new InMemoryRecoveryOperationPort();
    await expect(
      recordHostedRecoveryObservation({
        identity,
        body: observationFixture({
          target: {
            domain: 'ci_retry',
            repositoryId: 999_999_999,
            repository: 'jlapenna/agent-lcars',
            anchor: 42,
            exactIdentity: 'run:1:1',
          },
        }),
        portFactory: () => port,
      }),
    ).rejects.toThrow(HostedRecoveryObservationInputError);
  });
});
