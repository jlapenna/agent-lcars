import {
  buildRecoveryObservation,
  type RecoveryObservation,
} from '@agent-lcars/dispatch-contracts';
import { InMemoryRecoveryOperationPort } from '@agent-lcars/dispatch-controller/storage/recovery-in-memory-port';
import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

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

/** A fake `Octokit` reporting the given `run_attempt` for every run ID --
 *  enough for `ci_retry`'s verifier (apps/console/src/lib/
 *  recovery-observation-verification.ts), which is the only thing this
 *  file's fixtures need a working GitHub client for. */
function fakeOctokit(runAttempt: number): Octokit {
  return {
    rest: {
      actions: {
        getWorkflowRun: vi
          .fn()
          .mockResolvedValue({ data: { run_attempt: runAttempt } }),
      },
    },
  } as unknown as Octokit;
}

function failingOctokit(error: unknown): Octokit {
  return {
    rest: {
      actions: {
        getWorkflowRun: vi.fn().mockRejectedValue(error),
      },
    },
  } as unknown as Octokit;
}

describe('recordHostedRecoveryObservation', () => {
  it('records a well-formed observation and, once shadow-verified, resolves it executed', async () => {
    const port = new InMemoryRecoveryOperationPort();
    const observation = observationFixture();
    const result = await recordHostedRecoveryObservation({
      identity,
      body: observation,
      portFactory: () => port,
      octokitFactory: () => fakeOctokit(1),
    });
    expect(result.operationKey).toBe(observation.operationKey);
    expect(result.status).toBe('executed');
    expect(result.resolvedAt).toBeTruthy();
  });

  it('resolves failed when shadow verification finds a genuine mismatch', async () => {
    const port = new InMemoryRecoveryOperationPort();
    const observation = observationFixture({
      target: {
        domain: 'ci_retry',
        repositoryId: 1_307_149_765,
        repository: 'jlapenna/agent-lcars',
        anchor: 42,
        exactIdentity: 'run:1:3',
      },
    });
    const result = await recordHostedRecoveryObservation({
      identity,
      body: observation,
      portFactory: () => port,
      // GitHub reports attempt 1, but the observation claims attempt 3 was
      // already reached -- a real contradiction, not a lookup failure.
      octokitFactory: () => fakeOctokit(1),
    });
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/attempt 1/u);
    expect(result.detail).toMatch(/claims attempt 3/u);
  });

  it('leaves the operation pending when shadow verification is unavailable, not resolved with a fabricated result', async () => {
    const port = new InMemoryRecoveryOperationPort();
    const observation = observationFixture();
    const result = await recordHostedRecoveryObservation({
      identity,
      body: observation,
      portFactory: () => port,
      octokitFactory: () =>
        failingOctokit(
          Object.assign(new Error('service unavailable'), { status: 503 }),
        ),
    });
    expect(result.status).toBe('pending');
    expect(result.resolvedAt).toBeUndefined();
  });

  it('leaves the operation pending, and does not throw, when octokitFactory itself fails to construct a client', async () => {
    const port = new InMemoryRecoveryOperationPort();
    const observation = observationFixture();
    const result = await recordHostedRecoveryObservation({
      identity,
      body: observation,
      portFactory: () => port,
      octokitFactory: () => {
        throw new Error('AGENT_LCARS_GITHUB_TOKEN not defined');
      },
    });
    // The observation was already durably recorded before verification was
    // ever attempted -- a failure to even construct the verifier's GitHub
    // client must not turn that successful recording into a thrown error.
    expect(result.status).toBe('pending');
  });

  it('resolves mismatch (not left pending) when GitHub has no record of the claimed run', async () => {
    const port = new InMemoryRecoveryOperationPort();
    const observation = observationFixture();
    const result = await recordHostedRecoveryObservation({
      identity,
      body: observation,
      portFactory: () => port,
      octokitFactory: () =>
        failingOctokit(Object.assign(new Error('Not Found'), { status: 404 })),
    });
    expect(result.status).toBe('failed');
    expect(result.detail).toMatch(/no run 1/u);
  });

  it('leaves a domain with no verifier pending -- recording alone is still the primary contract', async () => {
    const port = new InMemoryRecoveryOperationPort();
    const observation = observationFixture({
      target: {
        domain: 'pr_healing',
        repositoryId: 1_307_149_765,
        repository: 'jlapenna/agent-lcars',
        anchor: 42,
        exactIdentity: 'pr:42:abc123',
      },
    });
    const result = await recordHostedRecoveryObservation({
      identity,
      body: observation,
      portFactory: () => port,
      octokitFactory: () => fakeOctokit(1),
    });
    expect(result.status).toBe('pending');
  });

  it('is idempotent for a replayed observation of the same fact once already resolved', async () => {
    const port = new InMemoryRecoveryOperationPort();
    const observation = observationFixture();
    const first = await recordHostedRecoveryObservation({
      identity,
      body: observation,
      portFactory: () => port,
      octokitFactory: () => fakeOctokit(1),
    });
    const second = await recordHostedRecoveryObservation({
      identity,
      body: observationFixture({ sourceKind: 'schedule' }),
      portFactory: () => port,
      // A second, different Octokit instance to prove the replay short-
      // circuits before ever calling it (already resolved -- see next
      // assertion) rather than merely returning the same answer by luck.
      octokitFactory: () => failingOctokit(new Error('must not be called')),
    });
    expect(second.recordedAt).toBe(first.recordedAt);
    expect(second.resolvedAt).toBe(first.resolvedAt);
    expect(second.status).toBe('executed');
    expect(second.observation.sourceKind).toBe('webhook');
  });

  it('retries verification on a replayed observation for a key still pending from an earlier unavailable attempt', async () => {
    const port = new InMemoryRecoveryOperationPort();
    const observation = observationFixture();
    const first = await recordHostedRecoveryObservation({
      identity,
      body: observation,
      portFactory: () => port,
      octokitFactory: () =>
        failingOctokit(
          Object.assign(new Error('service unavailable'), { status: 503 }),
        ),
    });
    expect(first.status).toBe('pending');

    const second = await recordHostedRecoveryObservation({
      identity,
      body: observation,
      portFactory: () => port,
      octokitFactory: () => fakeOctokit(1),
    });
    expect(second.status).toBe('executed');
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
