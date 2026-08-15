import type {
  AcceptedAttemptSpec,
  AgentResultClaimV1,
  RuntimeObservationEnvelope,
} from '@agent-lcars/dispatch-contracts';
import {
  attemptHistoryPayloadDigest,
  runtimeObservationPayloadSha256,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import type {
  AuthorityClock,
  LifecycleAuthorityStorage,
} from './authority-storage';
import { AuthorityConflict } from './authority-storage';
import { CancellationTaskEffectCoordinator } from './cancellation-effects';
import type {
  FinalizationCommitFailure,
  FinalizationHistoryCorruption,
  FinalizationHistoryInspection,
  FinalizationHistoryStorageHooks,
} from './finalization-history.in-memory.spec.support';
import {
  ingestVerifiedRunBinding,
  RunBindingIngressVerifier,
} from './launch-binding';
import {
  PresentationDeliveryBoundary,
  PresentationDeliveryCoordinator,
} from './presentation-delivery';
import { planDigest } from './presentation-delivery.spec.support';
import { launchedCancellationEffect } from './task-effects.spec.support';
import {
  AttemptFinalizer,
  ClaimObservationBoundary,
  TerminalObservationBoundary,
} from './terminal-finalizer';
import {
  activeFixture,
  evidenceVerifier,
} from './terminal-finalizer.spec.support';

const tenant = {
  tenantId: 'tenant-1',
  repositoryId: 123,
  repository: 'octo/example',
  installationId: 456,
};
const task = { tenantId: tenant.tenantId, repositoryId: 123, issueNumber: 9 };
const binding = {
  runId: 10,
  runAttempt: 1,
  checkRunId: 11,
  workflowPath: '.github/workflows/worker.yml',
  workflowRef: 'refs/heads/main',
  workflowSha: 'c'.repeat(40),
};
const DEADLINE = '2026-08-16T00:05:00.000Z';
const FINAL_TIME = '2026-08-16T00:06:00.000Z';

class ManualClock implements AuthorityClock {
  constructor(private value = '2026-08-16T00:00:00.000Z') {}
  now(): string {
    return this.value;
  }
  set(value: string): void {
    this.value = value;
  }
}

async function envelope(
  spec: AcceptedAttemptSpec,
  payload: RuntimeObservationEnvelope['payload'],
  overrides: Partial<RuntimeObservationEnvelope> = {},
): Promise<RuntimeObservationEnvelope> {
  return {
    schema: 'agent-lcars.runtime-observation/v1',
    version: 1,
    requestId: 'request-1',
    factId: 'fact-1',
    attemptId: spec.attemptId,
    tenant,
    task,
    source: { kind: 'github-provider', sourceId: 'source-1' },
    observedAt: '2026-08-16T00:00:00.000Z',
    payloadSha256: await runtimeObservationPayloadSha256(payload),
    payload,
    ...overrides,
  };
}

type TerminalConclusion =
  'success' | 'failure' | 'cancelled' | 'timed_out' | 'skipped';

const claimCases: readonly {
  label: string;
  claim: AgentResultClaimV1;
  result: string;
  reference?: { kind: 'pull-request'; number: number };
}[] = [
  {
    label: 'pull request',
    claim: {
      kind: 'pull-request',
      number: 44,
      localAttemptMarker: 'g1:intent-1',
    },
    result: 'pull-request',
    reference: { kind: 'pull-request', number: 44 },
  },
  {
    label: 'comment',
    claim: {
      kind: 'comment',
      commentId: 'comment-1',
      localAttemptMarker: 'g1:intent-1',
    },
    result: 'comment',
  },
  {
    label: 'review',
    claim: {
      kind: 'review',
      reviewId: 'review-1',
      pullNumber: 44,
      localAttemptMarker: 'g1:intent-1',
    },
    result: 'review',
  },
  {
    label: 'structured no-op',
    claim: {
      kind: 'structured-no-op',
      commentId: 'comment-no-op',
      localAttemptMarker: 'g1:intent-1',
    },
    result: 'no-op',
  },
];

interface PreparedFinalization {
  clock: ManualClock;
  storage: LifecycleAuthorityStorage;
  finalizer: AttemptFinalizer;
  lease: Awaited<ReturnType<typeof activeFixture>>['lease'];
  spec: AcceptedAttemptSpec;
  claimFactIds: string[];
}

async function prepare(
  makeStorage: (
    clock: AuthorityClock,
  ) => LifecycleAuthorityStorage | Promise<LifecycleAuthorityStorage>,
  input: {
    conclusion?: TerminalConclusion;
    claims?: readonly AgentResultClaimV1[];
    verdicts?: readonly (
      | { status: 'validated' }
      | {
          status: 'rejected';
          reason: 'marker-mismatch' | 'reference-mismatch';
        }
    )[];
  } = {},
): Promise<PreparedFinalization> {
  const clock = new ManualClock();
  const storage = await makeStorage(clock);
  const { lease, spec } = await activeFixture(storage);
  const verifier = evidenceVerifier();
  const finalizer = new AttemptFinalizer(storage, clock, {
    resolve: vi.fn(async (selection) => {
      const index = Number(selection.claimFactId.split('-').at(-1) ?? 1) - 1;
      return input.verdicts?.[index] ?? { status: 'validated' as const };
    }),
  });
  const conclusion = input.conclusion ?? 'success';
  const terminal = await new TerminalObservationBoundary(verifier).verify({
    envelope: await envelope(
      spec,
      { kind: 'run-terminal', binding, conclusion, observedAt: FINAL_TIME },
      { requestId: 'request-terminal', factId: 'fact-terminal' },
    ),
  });
  await finalizer.recordObservation(lease, terminal);

  const claims = input.claims ?? [];
  const claimFactIds: string[] = [];
  for (const [index, claimValue] of claims.entries()) {
    const factId = `fact-claim-${index + 1}`;
    const claim = await new ClaimObservationBoundary(verifier).parse({
      envelope: await envelope(
        spec,
        { kind: 'agent-result-claim', claim: claimValue },
        {
          requestId: `request-claim-${index + 1}`,
          factId,
          observedAt: '2026-08-16T00:04:00.000Z',
        },
      ),
    });
    await finalizer.recordObservation(lease, claim);
    claimFactIds.push(factId);
  }
  clock.set(DEADLINE);
  await finalizer.beginValidation(lease, tenant.tenantId, spec.attemptId);
  clock.set(FINAL_TIME);
  for (const claimFactId of claimFactIds) {
    await finalizer.resolveClaim(
      lease,
      tenant.tenantId,
      spec.attemptId,
      claimFactId,
    );
  }
  return { clock, storage, finalizer, lease, spec, claimFactIds };
}

async function prepareCancellationOwned(
  makeStorage: (
    clock: AuthorityClock,
  ) => LifecycleAuthorityStorage | Promise<LifecycleAuthorityStorage>,
): Promise<PreparedFinalization> {
  const clock = new ManualClock();
  const storage = await makeStorage(clock);
  const cancellation = await launchedCancellationEffect(
    storage,
    clock as never,
  );
  const admitted = await storage.readAttempt({
    tenantId: 'tenant-effects',
    attemptId: cancellation.attemptId,
  });
  if (admitted === undefined) throw new Error('missing cancellation Attempt');

  const runBindingVerifier = new RunBindingIngressVerifier({
    verifyExactRunBinding(): Promise<void> {
      return Promise.resolve();
    },
  });
  const bound = await runBindingVerifier.verify({
    envelope: {
      schema: 'agent-lcars.runtime-observation/v1',
      version: 1,
      requestId: 'request-cancellation-binding',
      factId: 'fact-cancellation-binding',
      attemptId: cancellation.attemptId,
      tenant: admitted.spec.tenant,
      task: admitted.spec.task,
      source: { kind: 'github-provider', sourceId: 'source-cancellation' },
      observedAt: '2026-08-16T00:00:00.000Z',
      payloadSha256: await runtimeObservationPayloadSha256({
        kind: 'run-bound',
        binding,
      }),
      payload: { kind: 'run-bound', binding },
    },
    localAttemptMarker: admitted.spec.local.attemptMarker,
  });
  await ingestVerifiedRunBinding(storage, cancellation.lease, bound);

  await new CancellationTaskEffectCoordinator(storage, clock).reconcile({
    lease: cancellation.lease,
    tenantId: admitted.spec.tenant.tenantId,
    task: admitted.spec.task,
    sourceFactId: cancellation.effect.sourceFactId,
    effectKey: cancellation.effect.effectKey,
  });

  const finalizer = new AttemptFinalizer(storage, clock, {
    resolve: async () => ({ status: 'validated' as const }),
  });
  const terminalPayload = {
    kind: 'run-terminal' as const,
    binding,
    conclusion: 'cancelled' as const,
    observedAt: '2026-08-16T00:00:00.000Z',
  };
  const terminal = await new TerminalObservationBoundary(
    evidenceVerifier(),
  ).verify({
    envelope: {
      schema: 'agent-lcars.runtime-observation/v1',
      version: 1,
      requestId: 'request-cancellation-terminal',
      factId: 'fact-cancellation-terminal',
      attemptId: cancellation.attemptId,
      tenant: admitted.spec.tenant,
      task: admitted.spec.task,
      source: { kind: 'github-provider', sourceId: 'source-cancellation' },
      observedAt: terminalPayload.observedAt,
      payloadSha256: await runtimeObservationPayloadSha256(terminalPayload),
      payload: terminalPayload,
    },
  });
  await finalizer.recordObservation(cancellation.lease, terminal);
  const lease = await storage.renewTaskLease({
    lease: cancellation.lease,
    leaseDurationMs: 60 * 60 * 1000,
  });
  clock.set(DEADLINE);
  await finalizer.beginValidation(
    lease,
    admitted.spec.tenant.tenantId,
    cancellation.attemptId,
  );
  clock.set(FINAL_TIME);
  return {
    clock,
    storage,
    finalizer,
    lease,
    spec: admitted.spec,
    claimFactIds: [],
  };
}

function finalizationRecords(inspection: FinalizationHistoryInspection): {
  command: {
    record: { recordDigest: string };
    payload: Record<string, unknown>;
  };
  evidence: {
    record: { recordDigest: string };
    payload: Record<string, unknown>;
  };
} {
  const records = inspection.history?.records;
  if (records === undefined) throw new Error('missing finalization history');
  const command = (records.get('command') ?? []).find(
    (entry) =>
      (entry.payload.payload as { kind?: string } | undefined)?.kind ===
      'finalize',
  );
  const evidence = (records.get('evidence') ?? [])[0];
  if (command === undefined || evidence === undefined)
    throw new Error('missing finalization command/evidence');
  return {
    command: command as typeof command & { payload: Record<string, unknown> },
    evidence: evidence as typeof evidence & {
      payload: Record<string, unknown>;
    },
  };
}

function expectOutcomeDigestConsistency(
  inspection: FinalizationHistoryInspection,
): void {
  const { command, evidence } = finalizationRecords(inspection);
  const commandPayload = command.payload.payload as Record<string, unknown>;
  const digest = commandPayload.outcomeDigest;
  expect(typeof digest).toBe('string');
  expect(evidence.payload.outcomeDigest).toBe(digest);
  expect(inspection.history?.head.outcomeDigest).toBe(digest);
  expect(inspection.outcomeIndex).toBeDefined();
  expect(JSON.parse(inspection.outcomeIndex as string)).toEqual(
    inspection.attempt?.outcome,
  );
  expect(inspection.presentation?.plan.outcomeDigest).toBe(digest);
  expect(inspection.presentationReceipt?.outcomeDigest).toBe(digest);
  const presentationPlan = inspection.presentation?.plan;
  if (presentationPlan !== undefined) {
    expect(inspection.delivery?.planDigest).toBe(planDigest(presentationPlan));
    if (inspection.deliveryReceipt !== undefined) {
      expect(inspection.deliveryReceipt.planDigest).toBe(
        planDigest(presentationPlan),
      );
    }
  }
}

/** Backend-independent final outcome/history/presentation transaction contract. */
export function runFinalizationHistoryStorageContract(
  makeStorage: (
    clock: AuthorityClock,
  ) => LifecycleAuthorityStorage | Promise<LifecycleAuthorityStorage>,
  hooks: FinalizationHistoryStorageHooks,
): void {
  describe('finalization outcome history storage contract', () => {
    it.each(claimCases)(
      'commits exact command, evidence, outcome, provenance, and receipts for a $label',
      async ({ claim, result, reference }) => {
        const prepared = await prepare(makeStorage, { claims: [claim] });
        const { clock, storage, finalizer, lease, spec, claimFactIds } =
          prepared;
        expect(
          await finalizer.finalize(lease, tenant.tenantId, spec.attemptId),
        ).toBe('applied');
        const inspection = hooks.inspectFinalization(storage, spec.attemptId);
        const attempt = inspection.attempt;
        expect(attempt).toMatchObject({
          phase: 'terminal',
          outcome: {
            terminalState: 'succeeded',
            execution: 'exited',
            result,
            finalizedAt: FINAL_TIME,
            evidence: {
              kind: 'validated-claim',
              claim,
            },
          },
        });
        if (reference === undefined) {
          expect(attempt?.outcome?.reference).toBeUndefined();
        } else {
          expect(attempt?.outcome?.reference).toEqual(reference);
        }
        const { command, evidence } = finalizationRecords(inspection);
        expect(command.payload.payload).toMatchObject({
          kind: 'finalize',
          commandId: expect.any(String),
          outcome: attempt?.outcome,
        });
        expect(command.payload.canonicalDigest).toMatch(/^[a-f0-9]{64}$/u);
        expect(evidence.payload).toMatchObject({
          finalizeCommandRef: inspection.finalizationReceipt?.commandRef,
          terminalFactRef:
            inspection.history?.head.finalization?.terminalFactRef,
          claimRefs: inspection.history?.head.finalization?.claimRefs,
          validationRefs: inspection.history?.head.finalization?.validationRefs,
          outcome: attempt?.outcome,
        });
        expect(inspection.history?.head.phase).toBe('terminal');
        expect(inspection.finalizationReceipt).toBeDefined();
        expect(inspection.history?.head.outcomeRef).toEqual(
          inspection.finalizationReceipt?.evidenceRef,
        );
        expect(inspection.history?.head.finalization?.claimRefs).toHaveLength(
          1,
        );
        expect(
          inspection.history?.head.finalization?.claimRefs[0]?.recordDigest,
        ).toBe(
          inspection.history?.records.get('claim')?.[0]?.record.recordDigest,
        );
        expect(
          inspection.history?.head.finalization?.validationRefs,
        ).toHaveLength(1);
        expect(inspection.finalizationReceipt?.commandId).toBe(
          (command.payload.payload as { commandId: string }).commandId,
        );
        expect(claimFactIds).toEqual(['fact-claim-1']);
        expectOutcomeDigestConsistency(inspection);
        expect(inspection.presentation?.deliveryState).toBe('pending');
        expect(inspection.delivery?.state).toBe('pending');
        expect(clock.now()).toBe(FINAL_TIME);
      },
    );

    it('commits a deterministic failed no-deliverable outcome for zero claims', async () => {
      const prepared = await prepare(makeStorage);
      const { storage, finalizer, lease, spec } = prepared;
      expect(
        await finalizer.finalize(lease, tenant.tenantId, spec.attemptId),
      ).toBe('applied');
      const inspection = hooks.inspectFinalization(storage, spec.attemptId);
      expect(inspection.attempt?.outcome).toMatchObject({
        terminalState: 'failed',
        result: 'none',
        evidenceValidation: { status: 'absent' },
      });
      expect(inspection.presentation?.plan.presentation).toMatchObject({
        terminalState: 'failed',
        result: 'none',
        evidenceValidation: 'absent',
      });
      expect(inspection.history?.head.finalization?.claimRefs).toEqual([]);
      expect(inspection.history?.head.finalization?.validationRefs).toEqual([]);
      expectOutcomeDigestConsistency(inspection);
    });

    it('records ambiguity, rather than selecting one of multiple validated claims', async () => {
      const prepared = await prepare(makeStorage, {
        claims: [claimCases[0].claim, claimCases[1].claim],
      });
      const { storage, finalizer, lease, spec } = prepared;
      await finalizer.finalize(lease, tenant.tenantId, spec.attemptId);
      const inspection = hooks.inspectFinalization(storage, spec.attemptId);
      expect(inspection.attempt?.outcome).toMatchObject({
        terminalState: 'failed',
        result: 'none',
        evidenceValidation: { status: 'ambiguous', candidateCount: 2 },
      });
      expect(inspection.history?.head.finalization?.claimRefs).toHaveLength(2);
      expect(
        inspection.history?.head.finalization?.validationRefs,
      ).toHaveLength(2);
      expectOutcomeDigestConsistency(inspection);
    });

    it.each(['failure', 'timed_out', 'skipped'] as const)(
      'preserves the reducer-derived %s terminal axis in history and presentation',
      async (conclusion) => {
        const prepared = await prepare(makeStorage, { conclusion });
        const { storage, finalizer, lease, spec } = prepared;
        await finalizer.finalize(lease, tenant.tenantId, spec.attemptId);
        const inspection = hooks.inspectFinalization(storage, spec.attemptId);
        expect(inspection.attempt?.outcome).toMatchObject({
          terminalState: 'failed',
          result: 'none',
          evidenceValidation: { status: 'not-applicable' },
        });
        expect(
          inspection.presentation?.plan.presentation.evidenceValidation,
        ).toBe('not-applicable');
        expectOutcomeDigestConsistency(inspection);
      },
    );

    it('finalizes a cancelled bound run as a terminal-run outcome with exact binding provenance', async () => {
      const prepared = await prepare(makeStorage, { conclusion: 'cancelled' });
      const { storage, finalizer, lease, spec } = prepared;
      await finalizer.finalize(lease, tenant.tenantId, spec.attemptId);
      const inspection = hooks.inspectFinalization(storage, spec.attemptId);
      expect(inspection.attempt?.outcome).toMatchObject({
        terminalState: 'cancelled',
        execution: 'cancelled',
        evidence: { kind: 'terminal-run', binding },
        evidenceValidation: { status: 'not-applicable' },
      });
      expect(
        inspection.presentation?.plan.presentation.evidenceValidation,
      ).toBe('not-applicable');
      expectOutcomeDigestConsistency(inspection);
    });

    it('rejects cancellation-owned finalization when its lifecycle provenance is corrupted', async () => {
      const prepared = await prepareCancellationOwned(makeStorage);
      const { storage, finalizer, lease, spec } = prepared;
      await finalizer.finalize(lease, 'tenant-effects', spec.attemptId);
      const before = hooks.inspectFinalization(storage, spec.attemptId);
      expect(before.attempt?.outcome?.evidence.kind).toBe('lifecycle-decision');
      hooks.corruptFinalization(storage, 'cancellation-provenance');
      const corrupted = hooks.inspectFinalization(storage, spec.attemptId);
      await expect(
        finalizer.finalize(lease, 'tenant-effects', spec.attemptId),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      expect(hooks.inspectFinalization(storage, spec.attemptId)).toEqual(
        corrupted,
      );
    });

    it('replays byte-identically after presentation delivery converges', async () => {
      const prepared = await prepare(makeStorage, {
        claims: [claimCases[0].claim],
      });
      const { clock, storage, finalizer, lease, spec } = prepared;
      await finalizer.finalize(lease, tenant.tenantId, spec.attemptId);
      const first = hooks.inspectFinalization(storage, spec.attemptId);
      const presentation = first.presentation;
      if (presentation === undefined) throw new Error('missing presentation');
      const target = {
        source: 'attempt' as const,
        tenantId: tenant.tenantId,
        task,
        attemptId: spec.attemptId,
        operationId: presentation.plan.operationId,
      };
      const coordinator = new PresentationDeliveryCoordinator(
        storage,
        new PresentationDeliveryBoundary(
          { receive: async () => ({ receiptSha256: 'd'.repeat(64) }) },
          clock,
        ),
      );
      clock.set('2026-08-16T00:07:00.000Z');
      await coordinator.deliver({ lease, target });
      expect((await storage.readPresentationDelivery(target))?.state).toBe(
        'converged',
      );
      expect(
        await finalizer.finalize(lease, tenant.tenantId, spec.attemptId),
      ).toBe('replay');
      expect(hooks.inspectFinalization(storage, spec.attemptId)).toEqual(
        expect.objectContaining({
          attempt: first.attempt,
          history: first.history,
          finalizationReceipt: first.finalizationReceipt,
          presentation: expect.objectContaining({ deliveryState: 'pending' }),
        }),
      );
      expectOutcomeDigestConsistency(
        hooks.inspectFinalization(storage, spec.attemptId),
      );
    });

    it('supports genuine pre-history compatibility while preserving the legacy final outcome', async () => {
      const prepared = await prepare(makeStorage, {
        claims: [claimCases[0].claim],
      });
      const { storage, finalizer, lease, spec } = prepared;
      hooks.deleteAttemptHistoryLineage(storage);
      await finalizer.finalize(lease, tenant.tenantId, spec.attemptId);
      const inspection = hooks.inspectFinalization(storage, spec.attemptId);
      expect(inspection.attempt?.phase).toBe('terminal');
      expect(inspection.attempt?.outcome?.result).toBe('pull-request');
      expect(inspection.history).toBeUndefined();
      expect(inspection.finalizationReceipt).toBeUndefined();
      expect(inspection.presentation?.deliveryState).toBe('pending');
      expect(inspection.presentation?.plan.outcomeDigest).not.toBe(
        attemptHistoryPayloadDigest(inspection.attempt?.outcome),
      );
      expect(
        await finalizer.finalize(lease, tenant.tenantId, spec.attemptId),
      ).toBe('replay');
      expect(hooks.inspectFinalization(storage, spec.attemptId)).toEqual(
        inspection,
      );
    });

    it.each<FinalizationHistoryCorruption>([
      'head',
      'terminal-predecessor',
      'claim-predecessor',
      'validation-predecessor',
      'finalize-command-record',
      'finalize-command-payload',
      'finalize-command-digest',
      'evidence-record',
      'evidence-payload',
      'evidence-digest',
      'terminal-ref',
      'claim-ref',
      'validation-ref',
      'outcome-ref',
      'outcome-digest',
      'legacy-outcome',
      'outcome-index',
      'finalization-receipt',
      'presentation',
      'presentation-receipt',
      'delivery',
    ])(
      'fails closed on independent %s corruption without further mutation',
      async (corruption) => {
        const prepared = await prepare(makeStorage, {
          claims: [claimCases[0].claim],
        });
        const { storage, finalizer, lease, spec } = prepared;
        await finalizer.finalize(lease, tenant.tenantId, spec.attemptId);
        hooks.corruptFinalization(storage, corruption);
        const corrupted = hooks.inspectFinalization(storage, spec.attemptId);
        await expect(
          finalizer.finalize(lease, tenant.tenantId, spec.attemptId),
        ).rejects.toBeInstanceOf(AuthorityConflict);
        expect(hooks.inspectFinalization(storage, spec.attemptId)).toEqual(
          corrupted,
        );
      },
    );

    it('fails closed when a converged delivery receipt is independently corrupted', async () => {
      const prepared = await prepare(makeStorage, {
        claims: [claimCases[0].claim],
      });
      const { clock, storage, finalizer, lease, spec } = prepared;
      await finalizer.finalize(lease, tenant.tenantId, spec.attemptId);
      const presentation = hooks.inspectFinalization(
        storage,
        spec.attemptId,
      ).presentation;
      if (presentation === undefined) throw new Error('missing presentation');
      const target = {
        source: 'attempt' as const,
        tenantId: tenant.tenantId,
        task,
        attemptId: spec.attemptId,
        operationId: presentation.plan.operationId,
      };
      await new PresentationDeliveryCoordinator(
        storage,
        new PresentationDeliveryBoundary(
          { receive: async () => ({ receiptSha256: 'd'.repeat(64) }) },
          clock,
        ),
      ).deliver({ lease, target });
      hooks.corruptFinalization(storage, 'delivery-receipt');
      const corrupted = hooks.inspectFinalization(storage, spec.attemptId);
      await expect(
        storage.readPresentationDelivery(target),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      await expect(
        finalizer.finalize(lease, tenant.tenantId, spec.attemptId),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      expect(hooks.inspectFinalization(storage, spec.attemptId)).toEqual(
        corrupted,
      );
    });

    it.each<FinalizationCommitFailure>([
      'attempt',
      'outcome-index',
      'history',
      'finalization-receipt',
      'presentation',
      'presentation-receipt',
      'delivery',
    ])(
      'rolls back the complete transaction when %s commit fails',
      async (stage) => {
        const prepared = await prepare(makeStorage, {
          claims: [claimCases[0].claim],
        });
        const { storage, finalizer, lease, spec } = prepared;
        const before = hooks.inspectFinalization(storage, spec.attemptId);
        const restore = hooks.failFinalizationCommit(storage, stage);
        try {
          await expect(
            finalizer.finalize(lease, tenant.tenantId, spec.attemptId),
          ).rejects.toThrow(stage);
        } finally {
          restore();
        }
        expect(hooks.inspectFinalization(storage, spec.attemptId)).toEqual(
          before,
        );
      },
    );
  });
}
