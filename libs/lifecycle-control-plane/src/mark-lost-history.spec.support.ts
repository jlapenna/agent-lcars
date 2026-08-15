import {
  type AcceptedAttemptSpec,
  attemptHistoryRecordReference,
  canonicalDurableJson,
  type RunBinding,
  sha256Digest,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import { readAttemptHistoryForTest } from './attempt-history-test-support';
import type { AttemptState } from './attempt-reducer';
import type {
  AttemptPresentationRecord,
  AuthorityClock,
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
  WriteResult,
} from './authority-storage';
import { RunStuckObservationBoundary } from './mark-lost-eligibility';
import { activeFixture } from './terminal-finalizer.spec.support';

const GRACE_MS = 4 * 60 * 60 * 1_000;
const INTERVAL_MS = 30 * 60 * 1_000;
const NOW = '2026-08-22T00:01:00.000Z';

export type MarkLostHistoryCorruption =
  | 'head'
  | 'baseline-fact-record'
  | 'baseline-fact-payload'
  | 'mark-lost-command-record'
  | 'mark-lost-command-payload'
  | 'mark-lost-command-digest'
  | 'command-ref'
  | 'evidence-record'
  | 'evidence-payload'
  | 'evidence-digest'
  | 'evidence-ref'
  | 'outcome-ref'
  | 'outcome-digest'
  | 'legacy-outcome'
  | 'outcome-index'
  | 'mark-lost-receipt'
  | 'presentation'
  | 'presentation-receipt'
  | 'delivery'
  | 'admission-receipt';

export type MarkLostCommitFailure =
  | 'attempt'
  | 'outcome-index'
  | 'history'
  | 'mark-lost-receipt'
  | 'presentation'
  | 'presentation-receipt'
  | 'delivery';

export interface MarkLostHistoryInspection {
  attempt: AttemptState | undefined;
  history: { head: unknown; records: Map<string, unknown[]> } | undefined;
  outcomeIndex: string | undefined;
  markLostReceipt: unknown;
  presentation: AttemptPresentationRecord | undefined;
  presentationReceipt: unknown;
  delivery: unknown;
  deliveryReceipt: unknown;
}

export interface MarkLostHistoryStorageHooks {
  inspectMarkLost(
    storage: LifecycleAuthorityStorage,
    attemptId: string,
  ): MarkLostHistoryInspection;
  corruptMarkLost(
    storage: LifecycleAuthorityStorage,
    corruption: MarkLostHistoryCorruption,
  ): void;
  failMarkLostCommit(
    storage: LifecycleAuthorityStorage,
    stage: MarkLostCommitFailure,
  ): () => void;
  deleteAttemptHistoryLineage(storage: LifecycleAuthorityStorage): void;
  cancelAttempt(
    storage: LifecycleAuthorityStorage,
    phase: 'active' | 'cancelling',
  ): void;
}

/** The serializable half of one mark-lost decision, assembled from storage. */
export interface MarkLostTerminationRequest {
  receiptId: string;
  idempotencyKey: string;
  authority: {
    authorityEpoch: number;
    attemptRevision: number;
    launchOperationId: string;
    executionEpoch: number;
  };
  task: unknown;
  head: unknown;
  baselineFactRef: unknown;
  factHistory: readonly unknown[];
  candidates: readonly unknown[];
}

export interface MarkLostCompositionFactory {
  create(
    clock: AuthorityClock,
  ): LifecycleAuthorityStorage | Promise<LifecycleAuthorityStorage>;
  historyHooks: MarkLostHistoryStorageHooks;
  terminate(input: {
    storage: LifecycleAuthorityStorage;
    lease: TaskAuthorityLease;
    now: string;
    request: MarkLostTerminationRequest;
  }): Promise<WriteResult>;
}

const OBSERVATION_PAYLOAD_DOMAIN =
  'agent-lcars.mark-lost-observation-payload/v1';
const OBSERVATION_DOMAIN = 'agent-lcars.mark-lost-observation/v1';

function domainDigest(domain: string, value: unknown): string {
  return sha256Digest(`${domain}\u0000${canonicalDurableJson(value)}`);
}

/**
 * Compute payloadDigest/canonicalDigest for an unsigned observation body
 * exactly as the observation boundary itself does, then attach them. Shared
 * by `runStuckCandidate` and `divergeRunStuckCandidate` so a mutation helper
 * never duplicates the digest recipe.
 */
export function signRunStuckObservation(
  unsigned: Record<string, unknown>,
): Record<string, unknown> {
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

/**
 * Build one candidate run-stuck observation exactly as a trusted adapter would
 * return it. The digests are the module's own domain digests, so the
 * observation boundary accepts it without any privileged access.
 */
export function runStuckCandidate(input: {
  number: number;
  observedAt: string;
  binding: RunBinding;
  status?: 'nonterminal' | 'terminal' | 'no-run' | 'contradiction';
  proofSalt?: string;
}): Record<string, unknown> {
  const status =
    input.status === 'terminal'
      ? { kind: 'terminal' as const, conclusion: 'failure' as const }
      : { kind: input.status ?? ('nonterminal' as const) };
  const unsigned = {
    schema: 'agent-lcars.run-stuck-observation/v1' as const,
    version: 1 as const,
    factId: `stuck-fact-${input.number}${input.proofSalt ?? ''}`,
    requestId: `stuck-request-${input.number}${input.proofSalt ?? ''}`,
    source: {
      kind: 'control-plane-reconciler' as const,
      sourceId: 'reconciler-1',
    },
    binding: input.binding,
    status,
    observedAt: input.observedAt,
    proofDigest: sha256Digest(`proof-${input.number}-${input.proofSalt ?? ''}`),
  };
  return signRunStuckObservation(unsigned);
}

/**
 * Diverge one field of an already-recorded candidate while keeping it
 * internally digest-consistent, so `RunStuckObservationBoundary` still
 * accepts it. The resulting mismatch against the ledger entry banked under
 * the original candidate is then visible only to the storage cross-check.
 */
export function divergeRunStuckCandidate(
  candidate: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const {
    payloadDigest: _payloadDigest,
    canonicalDigest: _canonicalDigest,
    ...unsigned
  } = candidate;
  return signRunStuckObservation({ ...unsigned, ...patch });
}

/**
 * Assemble a complete eligibility request from the storage adapter's own
 * durable history. Nothing here is privileged: the same reads a hosted
 * reconciler would perform produce the same evidence.
 */
export async function recordRunStuckCandidates(input: {
  storage: LifecycleAuthorityStorage;
  lease: TaskAuthorityLease;
  spec: AcceptedAttemptSpec;
  candidates: readonly unknown[];
}): Promise<void> {
  for (const candidate of input.candidates) {
    await input.storage.recordRunStuckObservation({
      lease: input.lease,
      tenantId: input.spec.tenant.tenantId,
      attemptId: input.spec.attemptId,
      observation: new RunStuckObservationBoundary({
        verifyRunStuck: () => candidate,
      }).verify({ candidate }),
    });
  }
}

export async function markLostRequest(input: {
  storage: LifecycleAuthorityStorage;
  lease: TaskAuthorityLease;
  spec: AcceptedAttemptSpec;
  receiptId?: string;
  idempotencyKey?: string;
  proofSalt?: string;
  /** Skip banking the evidence, to exercise the unrecorded-evidence path. */
  record?: boolean;
  /**
   * Applied after the candidates are recorded under the lease but before
   * they are returned in the request, so a test can bank one evidence set
   * and build a receipt from a divergent one. Mutated candidates must stay
   * digest-consistent themselves (see `divergeRunStuckCandidate`) or
   * `RunStuckObservationBoundary` rejects them before storage is reached.
   */
  mutateCandidates?: (
    candidates: Record<string, unknown>[],
  ) => Record<string, unknown>[];
}): Promise<MarkLostTerminationRequest> {
  const identity = {
    tenantId: input.spec.tenant.tenantId,
    attemptId: input.spec.attemptId,
  };
  const history = await readAttemptHistoryForTest(input.storage, {
    lease: input.lease,
    ...identity,
  });
  if (history === undefined) throw new Error('missing Attempt history');
  const baseline = history.records.fact.find(
    ({ payload }) =>
      (payload as { payload?: { kind?: string } }).payload?.kind ===
      'run-bound',
  );
  if (baseline === undefined) throw new Error('missing run-bound baseline');
  const payload = baseline.payload as {
    observedAt: string;
    payload: { binding: RunBinding };
  };
  const reference = attemptHistoryRecordReference(
    baseline.record,
    identity,
    'fact',
  );
  const baselineAt = Date.parse(payload.observedAt);
  const observedAt = (index: number): string =>
    new Date(baselineAt + GRACE_MS + index * INTERVAL_MS).toISOString();
  const candidates = [0, 1, 2].map((index) =>
    runStuckCandidate({
      number: index + 1,
      observedAt: observedAt(index),
      binding: payload.payload.binding,
      proofSalt: input.proofSalt,
    }),
  );
  if (input.record !== false) {
    await recordRunStuckCandidates({
      storage: input.storage,
      lease: input.lease,
      spec: input.spec,
      candidates,
    });
  }
  return {
    receiptId: input.receiptId ?? 'mark-lost-receipt-1',
    idempotencyKey: input.idempotencyKey ?? 'mark-lost-key-1',
    authority: {
      authorityEpoch: history.head.spec.activation.authorityEpoch,
      attemptRevision: history.head.aggregateRevision,
      launchOperationId: history.head.launch.operationId,
      executionEpoch: history.head.executionEpoch,
    },
    task: input.spec.task,
    head: history.head,
    baselineFactRef: reference,
    factHistory: [
      { reference, record: baseline.record, payload: baseline.payload },
    ],
    candidates: input.mutateCandidates
      ? input.mutateCandidates(candidates)
      : candidates,
  };
}

/**
 * Reusable provider-neutral contract for verified loss terminalization. The
 * aggregate storage suite invokes it with the reference adapter; a durable
 * backend can adopt the same semantics without exposing its internals.
 */
export function runMarkLostHistoryStorageContract(
  factory: MarkLostCompositionFactory,
): void {
  const prepare = async () => {
    const storage = await factory.create({ now: () => NOW });
    const { lease, spec } = await activeFixture(storage);
    const request = await markLostRequest({ storage, lease, spec });
    return { storage, lease, spec, request };
  };

  describe('mark-lost history storage contract', () => {
    it('atomically records the decision, evidence, presentation, and private receipt', async () => {
      const { storage, lease, spec, request } = await prepare();
      await expect(
        factory.terminate({ storage, lease, now: NOW, request }),
      ).resolves.toBe('applied');
      const inspection = factory.historyHooks.inspectMarkLost(
        storage,
        spec.attemptId,
      );
      expect(inspection.attempt).toMatchObject({
        phase: 'terminal',
        outcome: {
          terminalState: 'lost',
          execution: 'lost',
          result: 'none',
          evidence: { kind: 'lifecycle-decision' },
          finalizedAt: NOW,
        },
      });
      expect(inspection.history?.records.get('command')).toHaveLength(2);
      expect(inspection.history?.records.get('evidence')).toHaveLength(1);
      expect(inspection.markLostReceipt).toBeDefined();
      expect(inspection.presentation?.plan.terminal).toMatchObject({
        kind: 'lifecycle-decision',
        decision: 'mark-lost',
      });
      expect(inspection.delivery).toBeDefined();
      // Loss is an absence of observation, so no failure axis is projected.
      expect(inspection.attempt?.outcome?.failure).toBeUndefined();
      expect(
        (inspection.presentation?.plan.presentation as { failure?: unknown })
          .failure,
      ).toBeUndefined();
    });

    it('replays one durable decision at its committed time after the clock advances', async () => {
      const { storage, lease, spec, request } = await prepare();
      await factory.terminate({ storage, lease, now: NOW, request });
      const inspection = factory.historyHooks.inspectMarkLost(
        storage,
        spec.attemptId,
      );
      await expect(
        factory.terminate({
          storage,
          lease,
          now: '2026-08-22T00:45:00.000Z',
          request,
        }),
      ).resolves.toBe('replay');
      expect(
        factory.historyHooks.inspectMarkLost(storage, spec.attemptId),
      ).toEqual(inspection);
    });

    it('rejects reusing one receipt identity for different evidence', async () => {
      const { storage, lease, spec, request } = await prepare();
      // Both evidence sets are banked while the Attempt is still eligible, so
      // the conflict proves receipt identity is checked, not recordability.
      const changed = await markLostRequest({
        storage,
        lease,
        spec,
        proofSalt: '-alternate',
      });
      await factory.terminate({ storage, lease, now: NOW, request });
      const before = factory.historyHooks.inspectMarkLost(
        storage,
        spec.attemptId,
      );
      await expect(
        factory.terminate({ storage, lease, now: NOW, request: changed }),
      ).rejects.toThrow();
      expect(
        factory.historyHooks.inspectMarkLost(storage, spec.attemptId),
      ).toEqual(before);
    });

    it('refuses evidence that was never recorded under the lease', async () => {
      const storage = await factory.create({ now: () => NOW });
      const { lease, spec } = await activeFixture(storage);
      const request = await markLostRequest({
        storage,
        lease,
        spec,
        record: false,
      });
      await expect(
        factory.terminate({ storage, lease, now: NOW, request }),
      ).rejects.toThrow();
      const inspection = factory.historyHooks.inspectMarkLost(
        storage,
        spec.attemptId,
      );
      expect(inspection.attempt?.phase).toBe('active');
      expect(inspection.markLostReceipt).toBeUndefined();
      expect(inspection.presentation).toBeUndefined();
    });

    // Per-axis coverage of the ledger cross-check in
    // `assertMarkLostObservations`. Two axes it also matches on --
    // `observedAt` and `binding` -- are intentionally absent here:
    // `validateMarkLostEligibility` pins every observation's `observedAt` to
    // one exact instant per index (baseline+4h, +4h30m, +5h, with zero legal
    // slack) and requires every observation's `binding` to already equal the
    // baseline binding, so any divergent value on either axis is rejected by
    // eligibility before a request naming it ever reaches storage -- there is
    // no way to construct a case that would isolate the storage check.
    // Confirmed empirically: with `assertMarkLostObservations` temporarily
    // disabled, cases for those two axes still rejected (proving an earlier
    // gate catches them), while the axes below started being accepted
    // (proving they exercise only the storage check).
    it.each<{
      axis: string;
      mutate: (
        candidates: Record<string, unknown>[],
      ) => Record<string, unknown>[];
    }>([
      {
        axis: 'proofDigest',
        mutate: ([first, ...rest]) => [
          divergeRunStuckCandidate(first, {
            proofDigest: sha256Digest('divergent-proof'),
          }),
          ...rest,
        ],
      },
      {
        axis: 'source.sourceId',
        mutate: ([first, ...rest]) => [
          divergeRunStuckCandidate(first, {
            source: {
              ...(first.source as Record<string, unknown>),
              sourceId: 'reconciler-2',
            },
          }),
          ...rest,
        ],
      },
      {
        axis: 'requestId',
        mutate: ([first, ...rest]) => [
          divergeRunStuckCandidate(first, {
            requestId: `${first.requestId as string}-divergent`,
          }),
          ...rest,
        ],
      },
    ])(
      'refuses a receipt whose $axis diverges from the recorded ledger entry',
      async ({ mutate }) => {
        const storage = await factory.create({ now: () => NOW });
        const { lease, spec } = await activeFixture(storage);
        const request = await markLostRequest({
          storage,
          lease,
          spec,
          mutateCandidates: mutate,
        });
        await expect(
          factory.terminate({ storage, lease, now: NOW, request }),
        ).rejects.toThrow();
        const inspection = factory.historyHooks.inspectMarkLost(
          storage,
          spec.attemptId,
        );
        expect(inspection.attempt?.phase).toBe('active');
        expect(inspection.markLostReceipt).toBeUndefined();
        expect(inspection.presentation).toBeUndefined();
      },
    );

    // A receipt naming only two of the three recorded observations is not
    // covered here: `validateMarkLostEligibility`'s `exactObservations` guard
    // requires the observations array to have exactly three dense own
    // properties before the storage cross-check is ever reached, so a
    // two-entry receipt is rejected by eligibility, not by the ledger check.

    it('accepts a receipt naming three of four genuinely recorded observations', async () => {
      const storage = await factory.create({ now: () => NOW });
      const { lease, spec } = await activeFixture(storage);
      const request = await markLostRequest({ storage, lease, spec });
      const binding = (request.candidates[0] as { binding: RunBinding })
        .binding;
      // A fourth observation is banked under the same lease but never named
      // in the receipt. Extra genuine ledger entries are legitimate, so this
      // must still succeed -- it proves the cross-check is not secretly "the
      // ledger must contain exactly these three observations."
      await recordRunStuckCandidates({
        storage,
        lease,
        spec,
        candidates: [
          runStuckCandidate({ number: 4, observedAt: NOW, binding }),
        ],
      });
      await expect(
        factory.terminate({ storage, lease, now: NOW, request }),
      ).resolves.toBe('applied');
      const inspection = factory.historyHooks.inspectMarkLost(
        storage,
        spec.attemptId,
      );
      expect(inspection.markLostReceipt).toBeDefined();
    });

    it('refuses an Attempt with no bounded history instead of fabricating a lineage', async () => {
      const { storage, lease, spec, request } = await prepare();
      factory.historyHooks.deleteAttemptHistoryLineage(storage);
      await expect(
        factory.terminate({ storage, lease, now: NOW, request }),
      ).rejects.toThrow();
      const inspection = factory.historyHooks.inspectMarkLost(
        storage,
        spec.attemptId,
      );
      expect(inspection.attempt?.phase).toBe('active');
      expect(inspection.markLostReceipt).toBeUndefined();
      expect(inspection.presentation).toBeUndefined();
    });

    it.each<'active' | 'cancelling'>(['active', 'cancelling'])(
      'refuses a %s Attempt that already carries a cancellation',
      async (phase) => {
        const { storage, lease, spec, request } = await prepare();
        factory.historyHooks.cancelAttempt(storage, phase);
        const before = factory.historyHooks.inspectMarkLost(
          storage,
          spec.attemptId,
        );
        await expect(
          factory.terminate({ storage, lease, now: NOW, request }),
        ).rejects.toThrow();
        expect(
          factory.historyHooks.inspectMarkLost(storage, spec.attemptId),
        ).toEqual(before);
      },
    );

    it.each<MarkLostHistoryCorruption>([
      'head',
      'baseline-fact-record',
      'baseline-fact-payload',
      'mark-lost-command-record',
      'mark-lost-command-payload',
      'mark-lost-command-digest',
      'command-ref',
      'evidence-record',
      'evidence-payload',
      'evidence-digest',
      'evidence-ref',
      'outcome-ref',
      'outcome-digest',
      'legacy-outcome',
      'outcome-index',
      'mark-lost-receipt',
      'presentation',
      'presentation-receipt',
      'delivery',
      'admission-receipt',
    ])('fails closed on independent %s corruption', async (corruption) => {
      const { storage, lease, spec, request } = await prepare();
      await factory.terminate({ storage, lease, now: NOW, request });
      factory.historyHooks.corruptMarkLost(storage, corruption);
      const corrupted = factory.historyHooks.inspectMarkLost(
        storage,
        spec.attemptId,
      );
      await expect(
        factory.terminate({ storage, lease, now: NOW, request }),
      ).rejects.toThrow();
      expect(
        factory.historyHooks.inspectMarkLost(storage, spec.attemptId),
      ).toEqual(corrupted);
    });

    it.each<MarkLostCommitFailure>([
      'attempt',
      'outcome-index',
      'history',
      'mark-lost-receipt',
      'presentation',
      'presentation-receipt',
      'delivery',
    ])('rolls back every durable write when %s fails', async (stage) => {
      const { storage, lease, spec, request } = await prepare();
      const before = factory.historyHooks.inspectMarkLost(
        storage,
        spec.attemptId,
      );
      const restore = factory.historyHooks.failMarkLostCommit(storage, stage);
      try {
        await expect(
          factory.terminate({ storage, lease, now: NOW, request }),
        ).rejects.toThrow();
      } finally {
        restore();
      }
      expect(
        factory.historyHooks.inspectMarkLost(storage, spec.attemptId),
      ).toEqual(before);
      await expect(
        factory.terminate({ storage, lease, now: NOW, request }),
      ).resolves.toBe('applied');
    });
  });
}
