import {
  type AcceptedAttemptSpec,
  canonicalDurableJson,
  type RunBinding,
  sha256Digest,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import {
  type AttemptHistoryInspection,
  readAttemptHistoryForTest,
} from './attempt-history-test-support';
import type { AttemptState } from './attempt-reducer';
import {
  type AuthorityClock,
  InMemoryLifecycleAuthorityStorage,
  type LaunchOutboxRecord,
  type LifecycleAuthorityStorage,
  type TaskAuthorityLease,
} from './authority-storage';
import {
  RunStuckObservationBoundary,
  type VerifiedRunStuckObservation,
} from './mark-lost-eligibility';
import { runStuckCandidate } from './mark-lost-history.spec.support';
import { activeFixture } from './terminal-finalizer.spec.support';

const BASELINE_AT = '2026-08-16T00:00:00.000Z';
const OBSERVED_AT_1 = '2026-08-16T04:00:00.000Z';
const OBSERVED_AT_2 = '2026-08-16T04:30:00.000Z';

const OBSERVATION_PAYLOAD_DOMAIN =
  'agent-lcars.mark-lost-observation-payload/v1';
const OBSERVATION_DOMAIN = 'agent-lcars.mark-lost-observation/v1';

class Clock implements AuthorityClock {
  constructor(private value: string) {}

  now(): string {
    return this.value;
  }

  set(value: string): void {
    this.value = value;
  }
}

/**
 * A local copy of the double-cast helper other in-memory storage specs use to
 * reach private maps. Duplicated deliberately per this file's own task
 * instructions, rather than imported, so this spec stays independent of
 * concurrent edits to sibling support modules.
 */
interface InMemoryInternals {
  attempts: Map<string, AttemptState>;
  launches: Map<string, LaunchOutboxRecord>;
  attemptPresentations: Map<string, unknown>;
  presentationDeliveries: Map<string, unknown>;
  runStuckObservations: Map<string, unknown>;
  runStuckObservationRequests: Map<string, string>;
}

function internals(storage: LifecycleAuthorityStorage): InMemoryInternals {
  return storage as unknown as InMemoryInternals;
}

function requireAttempt(
  storage: LifecycleAuthorityStorage,
  attemptId: string,
): AttemptState {
  const attempt = internals(storage).attempts.get(attemptId);
  if (attempt === undefined) throw new Error('missing Attempt');
  return attempt;
}

function streamCounts(inspection: AttemptHistoryInspection) {
  return {
    fact: inspection.records.fact.length,
    command: inspection.records.command.length,
    claim: inspection.records.claim.length,
    validation: inspection.records.validation.length,
    evidence: inspection.records.evidence.length,
  };
}

function domainDigest(domain: string, value: unknown): string {
  return sha256Digest(`${domain}\u0000${canonicalDurableJson(value)}`);
}

/**
 * A local candidate builder, distinct from `runStuckCandidate`, for the rows
 * that need factId/requestId/source independently controlled -- axes that
 * helper's `number`/`proofSalt` inputs tie together by construction.
 */
function buildCandidate(input: {
  factId: string;
  requestId: string;
  binding: RunBinding;
  observedAt: string;
  proofSeed: string;
  source?: {
    kind: 'actions-adapter' | 'github-provider' | 'control-plane-reconciler';
    sourceId: string;
  };
}): Record<string, unknown> {
  const unsigned = {
    schema: 'agent-lcars.run-stuck-observation/v1' as const,
    version: 1 as const,
    factId: input.factId,
    requestId: input.requestId,
    source: input.source ?? {
      kind: 'control-plane-reconciler' as const,
      sourceId: 'reconciler-1',
    },
    binding: input.binding,
    status: { kind: 'nonterminal' as const },
    observedAt: input.observedAt,
    proofDigest: sha256Digest(`proof-${input.proofSeed}`),
  };
  const payloadDigest = domainDigest(OBSERVATION_PAYLOAD_DOMAIN, unsigned);
  return {
    ...unsigned,
    payloadDigest,
    canonicalDigest: domainDigest(OBSERVATION_DOMAIN, {
      ...unsigned,
      payloadDigest,
    }),
  };
}

function verifyObservation(
  candidate: Record<string, unknown>,
): VerifiedRunStuckObservation {
  return new RunStuckObservationBoundary({
    verifyRunStuck: () => candidate,
  }).verify({ candidate });
}

async function prepare(): Promise<{
  clock: Clock;
  storage: InMemoryLifecycleAuthorityStorage;
  lease: TaskAuthorityLease;
  spec: AcceptedAttemptSpec;
  attempt: AttemptState;
  binding: RunBinding;
}> {
  const clock = new Clock(BASELINE_AT);
  const storage = new InMemoryLifecycleAuthorityStorage(clock, {
    mint: () => 'A'.repeat(22),
  });
  const { lease, spec } = await activeFixture(storage);
  const attempt = await storage.readAttempt({
    tenantId: spec.tenant.tenantId,
    attemptId: spec.attemptId,
  });
  if (attempt === undefined) throw new Error('missing Attempt');
  if (attempt.binding === undefined) throw new Error('missing binding');
  return { clock, storage, lease, spec, attempt, binding: attempt.binding };
}

describe('recordRunStuckObservation', () => {
  it('records a verified non-terminal observation and returns applied', async () => {
    const { storage, lease, spec, binding } = await prepare();
    const observation = verifyObservation(
      runStuckCandidate({
        number: 1,
        observedAt: OBSERVED_AT_1,
        binding,
      }),
    );

    await expect(
      storage.recordRunStuckObservation({
        lease,
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
        observation,
      }),
    ).resolves.toBe('applied');
  });

  it('is inert: recording evidence changes nothing about the Attempt but the ledger', async () => {
    const { storage, lease, spec, attempt: before, binding } = await prepare();
    const historyBefore = await readAttemptHistoryForTest(storage, {
      lease,
      tenantId: spec.tenant.tenantId,
      attemptId: spec.attemptId,
    });
    if (historyBefore === undefined) {
      throw new Error('missing Attempt history');
    }
    const countsBefore = streamCounts(historyBefore);
    expect(internals(storage).attemptPresentations.size).toBe(0);
    expect(internals(storage).presentationDeliveries.size).toBe(0);

    const observation = verifyObservation(
      runStuckCandidate({
        number: 1,
        observedAt: OBSERVED_AT_1,
        binding,
      }),
    );
    await expect(
      storage.recordRunStuckObservation({
        lease,
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
        observation,
      }),
    ).resolves.toBe('applied');

    const after = await storage.readAttempt({
      tenantId: spec.tenant.tenantId,
      attemptId: spec.attemptId,
    });
    expect(after?.phase).toBe(before.phase);
    expect(after?.revision).toBe(before.revision);
    expect(after?.binding).toEqual(before.binding);
    expect(after?.futureGrantsDenied).toBe(before.futureGrantsDenied);
    expect(after?.outcome).toEqual(before.outcome);
    expect(after?.facts).toEqual(before.facts);

    const historyAfter = await readAttemptHistoryForTest(storage, {
      lease,
      tenantId: spec.tenant.tenantId,
      attemptId: spec.attemptId,
    });
    if (historyAfter === undefined) {
      throw new Error('missing Attempt history');
    }
    expect(streamCounts(historyAfter)).toEqual(countsBefore);

    expect(internals(storage).attemptPresentations.size).toBe(0);
    expect(internals(storage).presentationDeliveries.size).toBe(0);
  });

  it('replays the same observation and leaves exactly one ledger entry', async () => {
    const { storage, lease, spec, binding } = await prepare();
    const observation = verifyObservation(
      runStuckCandidate({
        number: 1,
        observedAt: OBSERVED_AT_1,
        binding,
      }),
    );
    const input = {
      lease,
      tenantId: spec.tenant.tenantId,
      attemptId: spec.attemptId,
      observation,
    };

    await expect(storage.recordRunStuckObservation(input)).resolves.toBe(
      'applied',
    );
    await expect(storage.recordRunStuckObservation(input)).resolves.toBe(
      'replay',
    );

    expect(internals(storage).runStuckObservations.size).toBe(1);
    expect(internals(storage).runStuckObservationRequests.size).toBe(1);
  });

  it('rejects reusing one factId for different observation content', async () => {
    const { storage, lease, spec, binding } = await prepare();
    const first = verifyObservation(
      buildCandidate({
        factId: 'stuck-fact-shared',
        requestId: 'stuck-request-1',
        binding,
        observedAt: OBSERVED_AT_1,
        proofSeed: 'first',
      }),
    );
    await storage.recordRunStuckObservation({
      lease,
      tenantId: spec.tenant.tenantId,
      attemptId: spec.attemptId,
      observation: first,
    });

    const second = verifyObservation(
      buildCandidate({
        factId: 'stuck-fact-shared',
        requestId: 'stuck-request-2',
        binding,
        observedAt: OBSERVED_AT_2,
        proofSeed: 'second',
      }),
    );
    await expect(
      storage.recordRunStuckObservation({
        lease,
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
        observation: second,
      }),
    ).rejects.toThrow('Run-stuck observation identity was reused differently');
  });

  it('rejects binding one requestId to a different factId', async () => {
    const { storage, lease, spec, binding } = await prepare();
    const first = verifyObservation(
      buildCandidate({
        factId: 'stuck-fact-a',
        requestId: 'stuck-request-shared',
        binding,
        observedAt: OBSERVED_AT_1,
        proofSeed: 'a',
      }),
    );
    await storage.recordRunStuckObservation({
      lease,
      tenantId: spec.tenant.tenantId,
      attemptId: spec.attemptId,
      observation: first,
    });

    const second = verifyObservation(
      buildCandidate({
        factId: 'stuck-fact-b',
        requestId: 'stuck-request-shared',
        binding,
        observedAt: OBSERVED_AT_2,
        proofSeed: 'b',
      }),
    );
    await expect(
      storage.recordRunStuckObservation({
        lease,
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
        observation: second,
      }),
    ).rejects.toThrow('Run-stuck observation identity was reused differently');
  });

  it('rejects an observation not minted by RunStuckObservationBoundary', async () => {
    const { storage, lease, spec, binding } = await prepare();
    const forged = {
      schema: 'agent-lcars.run-stuck-observation/v1',
      version: 1,
      factId: 'stuck-fact-forged',
      requestId: 'stuck-request-forged',
      source: { kind: 'control-plane-reconciler', sourceId: 'reconciler-1' },
      binding,
      status: { kind: 'nonterminal' },
      observedAt: OBSERVED_AT_1,
      proofDigest: 'a'.repeat(64),
      payloadDigest: 'a'.repeat(64),
      canonicalDigest: 'a'.repeat(64),
    } as unknown as VerifiedRunStuckObservation;

    await expect(
      storage.recordRunStuckObservation({
        lease,
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
        observation: forged,
      }),
    ).rejects.toThrow('Run-stuck observation was not verified at its boundary');
  });

  it.each(['terminal', 'no-run', 'contradiction'] as const)(
    'rejects a %s verifier status as loss evidence',
    async (status) => {
      const { storage, lease, spec, binding } = await prepare();
      const observation = verifyObservation(
        runStuckCandidate({
          number: 1,
          observedAt: OBSERVED_AT_1,
          binding,
          status,
        }),
      );

      await expect(
        storage.recordRunStuckObservation({
          lease,
          tenantId: spec.tenant.tenantId,
          attemptId: spec.attemptId,
          observation,
        }),
      ).rejects.toThrow('Run-stuck observation is not loss evidence');
    },
  );

  it.each(['actions-adapter', 'github-provider'] as const)(
    'rejects a %s source, which cannot assert its own run is stuck',
    async (kind) => {
      const { storage, lease, spec, binding } = await prepare();
      const observation = verifyObservation(
        buildCandidate({
          factId: 'stuck-fact-untrusted',
          requestId: 'stuck-request-untrusted',
          binding,
          observedAt: OBSERVED_AT_1,
          proofSeed: 'untrusted',
          source: { kind, sourceId: 'source-1' },
        }),
      );

      await expect(
        storage.recordRunStuckObservation({
          lease,
          tenantId: spec.tenant.tenantId,
          attemptId: spec.attemptId,
          observation,
        }),
      ).rejects.toThrow('Run-stuck observation source is untrusted');
    },
  );

  it("rejects an observation whose binding differs from the Attempt's live binding", async () => {
    const { storage, lease, spec, binding } = await prepare();
    const observation = verifyObservation(
      runStuckCandidate({
        number: 1,
        observedAt: OBSERVED_AT_1,
        binding: { ...binding, runId: binding.runId + 1 },
      }),
    );

    await expect(
      storage.recordRunStuckObservation({
        lease,
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
        observation,
      }),
    ).rejects.toThrow('Run-stuck observation contradicts current Attempt');
  });

  it('rejects an unknown attemptId', async () => {
    const { storage, lease, spec, binding } = await prepare();
    const observation = verifyObservation(
      runStuckCandidate({
        number: 1,
        observedAt: OBSERVED_AT_1,
        binding,
      }),
    );

    await expect(
      storage.recordRunStuckObservation({
        lease,
        tenantId: spec.tenant.tenantId,
        attemptId: 'B'.repeat(22),
        observation,
      }),
    ).rejects.toThrow('Run-stuck observation scope is invalid');
  });

  it('rejects a tenantId that does not match the Attempt', async () => {
    const { storage, lease, spec, binding } = await prepare();
    const observation = verifyObservation(
      runStuckCandidate({
        number: 1,
        observedAt: OBSERVED_AT_1,
        binding,
      }),
    );

    await expect(
      storage.recordRunStuckObservation({
        lease,
        tenantId: 'tenant-other',
        attemptId: spec.attemptId,
        observation,
      }),
    ).rejects.toThrow('Run-stuck observation scope is invalid');
  });

  it('rejects a lease for a different task', async () => {
    const { storage, lease, spec, binding } = await prepare();
    const foreignLease = await storage.acquireTaskLease({
      scope: { ...spec.task, issueNumber: spec.task.issueNumber + 1 },
      ownerId: lease.ownerId,
      leaseDurationMs: 60 * 60 * 1000,
    });
    const observation = verifyObservation(
      runStuckCandidate({
        number: 1,
        observedAt: OBSERVED_AT_1,
        binding,
      }),
    );

    await expect(
      storage.recordRunStuckObservation({
        lease: foreignLease,
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
        observation,
      }),
    ).rejects.toThrow('Lease belongs to another task');
  });

  it('rejects an expired lease', async () => {
    const { clock, storage, lease, spec, binding } = await prepare();
    const observation = verifyObservation(
      runStuckCandidate({
        number: 1,
        observedAt: OBSERVED_AT_1,
        binding,
      }),
    );
    clock.set(new Date(Date.parse(lease.expiresAt) + 1_000).toISOString());

    await expect(
      storage.recordRunStuckObservation({
        lease,
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
        observation,
      }),
    ).rejects.toThrow('Stale, expired, or foreign task lease');
  });

  it('rejects when the Attempt phase is no longer active', async () => {
    const { storage, lease, spec, binding } = await prepare();
    const observation = verifyObservation(
      runStuckCandidate({
        number: 1,
        observedAt: OBSERVED_AT_1,
        binding,
      }),
    );
    requireAttempt(storage, spec.attemptId).phase = 'cancelling';

    await expect(
      storage.recordRunStuckObservation({
        lease,
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
        observation,
      }),
    ).rejects.toThrow('Run-stuck observation contradicts current Attempt');
  });

  it('rejects when the Attempt already carries a cancellation', async () => {
    const { storage, lease, spec, binding } = await prepare();
    const observation = verifyObservation(
      runStuckCandidate({
        number: 1,
        observedAt: OBSERVED_AT_1,
        binding,
      }),
    );
    requireAttempt(storage, spec.attemptId).cancellation = {
      eventId: 'cancel-event-1',
    };

    await expect(
      storage.recordRunStuckObservation({
        lease,
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
        observation,
      }),
    ).rejects.toThrow('Run-stuck observation contradicts current Attempt');
  });

  it('rejects when future grants are already denied', async () => {
    const { storage, lease, spec, binding } = await prepare();
    const observation = verifyObservation(
      runStuckCandidate({
        number: 1,
        observedAt: OBSERVED_AT_1,
        binding,
      }),
    );
    requireAttempt(storage, spec.attemptId).futureGrantsDenied = true;

    await expect(
      storage.recordRunStuckObservation({
        lease,
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
        observation,
      }),
    ).rejects.toThrow('Run-stuck observation contradicts current Attempt');
  });

  it('rejects when the launch is no longer accepted', async () => {
    const { storage, lease, spec, binding } = await prepare();
    const observation = verifyObservation(
      runStuckCandidate({
        number: 1,
        observedAt: OBSERVED_AT_1,
        binding,
      }),
    );
    const launch = internals(storage).launches.get(spec.attemptId);
    if (launch === undefined) throw new Error('missing launch');
    launch.state = 'suppressed';

    await expect(
      storage.recordRunStuckObservation({
        lease,
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
        observation,
      }),
    ).rejects.toThrow('Run-stuck observation contradicts current Attempt');
  });
});
