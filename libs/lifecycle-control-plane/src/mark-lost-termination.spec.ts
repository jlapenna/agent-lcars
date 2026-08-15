import type {
  AcceptedAttemptSpec,
  AttemptHistoryHead,
  AttemptHistoryStream,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import type { AttemptState } from './attempt-reducer';
import {
  type AuthorityClock,
  InMemoryLifecycleAuthorityStorage,
  type LaunchOutboxRecord,
  type LifecycleAuthorityStorage,
  type TaskAuthorityLease,
} from './authority-storage';
import { MarkLostBoundary, markLostLeaseFence } from './mark-lost-capability';
import { MarkLostComposition } from './mark-lost-composition';
import {
  type MarkLostEligibilityReceipt,
  RunStuckObservationBoundary,
  validateMarkLostEligibility,
} from './mark-lost-eligibility';
import {
  markLostRequest,
  type MarkLostTerminationRequest,
} from './mark-lost-history.spec.support';
import { activeFixture } from './terminal-finalizer.spec.support';

const NOW = '2026-08-22T00:01:00.000Z';

class Clock implements AuthorityClock {
  constructor(private value: string) {}

  now(): string {
    return this.value;
  }

  set(value: string): void {
    this.value = value;
  }
}

interface RawHistoryEntry {
  record: {
    recordDigest: string;
    previousRecordDigest: string | null;
  };
  payload: Record<string, unknown>;
}

interface RawHistory {
  head: AttemptHistoryHead;
  records: Map<AttemptHistoryStream, RawHistoryEntry[]>;
}

/**
 * A local copy of the double-cast helper other in-memory storage specs use to
 * reach private maps. Duplicated deliberately per this file's own task
 * instructions, rather than imported, so this spec stays independent of
 * concurrent edits to the launch-rejection support module.
 */
interface InMemoryInternals {
  attempts: Map<string, AttemptState>;
  launches: Map<string, LaunchOutboxRecord>;
  attemptHistories: Map<string, RawHistory>;
  taskHistories: Map<string, unknown>;
  acceptances: Map<string, unknown>;
  attemptAdmissionHistoryReceipts: Map<string, { attemptId?: string }>;
  markLostReceipts: Map<string, unknown>;
}

function internals(storage: LifecycleAuthorityStorage): InMemoryInternals {
  return storage as unknown as InMemoryInternals;
}

async function prepare(): Promise<{
  storage: InMemoryLifecycleAuthorityStorage;
  lease: TaskAuthorityLease;
  spec: AcceptedAttemptSpec;
  request: MarkLostTerminationRequest;
}> {
  const clock = new Clock(NOW);
  const storage = new InMemoryLifecycleAuthorityStorage(clock, {
    mint: () => 'A'.repeat(22),
  });
  const { lease, spec } = await activeFixture(storage);
  const request = await markLostRequest({ storage, lease, spec });
  return { storage, lease, spec, request };
}

function mintObservations(candidates: readonly unknown[]): unknown[] {
  const boundary = new RunStuckObservationBoundary({
    verifyRunStuck: ({ candidate }) => candidate,
  });
  return candidates.map((candidate) => boundary.verify({ candidate }));
}

/**
 * Mint a real eligibility receipt exactly as `MarkLostComposition` would,
 * without going through the storage commit -- so tests can control which
 * lease the receipt is pinned to independently of which lease later commits.
 */
function mintEligibilityReceipt(input: {
  lease: TaskAuthorityLease;
  request: MarkLostTerminationRequest;
}): MarkLostEligibilityReceipt {
  return validateMarkLostEligibility({
    schema: 'agent-lcars.mark-lost-eligibility-request/v1',
    version: 1,
    receiptId: input.request.receiptId,
    idempotencyKey: input.request.idempotencyKey,
    authority: {
      ...input.request.authority,
      fence: markLostLeaseFence(input.lease),
    },
    task: input.request.task,
    head: input.request.head,
    baselineFactRef: input.request.baselineFactRef,
    factHistory: input.request.factHistory,
    observations: mintObservations(input.request.candidates),
  });
}

function terminateComposition(input: {
  storage: LifecycleAuthorityStorage;
  lease: TaskAuthorityLease;
  request: MarkLostTerminationRequest;
}): ReturnType<MarkLostComposition['terminate']> {
  const composition = new MarkLostComposition({
    storage: input.storage,
    clock: new Clock(NOW),
    verifier: { verifyRunStuck: ({ candidate }) => candidate },
  });
  return composition.terminate({ lease: input.lease, ...input.request });
}

async function expectNoPartialMutation(
  storage: LifecycleAuthorityStorage,
  spec: AcceptedAttemptSpec,
): Promise<void> {
  const attempt = await storage.readAttempt({
    tenantId: spec.tenant.tenantId,
    attemptId: spec.attemptId,
  });
  expect(attempt?.phase).toBe('active');
  expect(internals(storage).markLostReceipts.size).toBe(0);
}

function requireAttempt(
  storage: LifecycleAuthorityStorage,
  attemptId: string,
): AttemptState {
  const attempt = internals(storage).attempts.get(attemptId);
  if (attempt === undefined) throw new Error('missing Attempt');
  return attempt;
}

describe('InMemoryLifecycleAuthorityStorage.terminateLostAttempt fails closed', () => {
  it('rejects a termination the boundary never minted', async () => {
    const { storage, lease, spec, request } = await prepare();
    const receipt = mintEligibilityReceipt({ lease, request });

    await expect(
      storage.terminateLostAttempt({
        lease,
        termination: { receipt, terminatedAt: NOW } as never,
      }),
    ).rejects.toThrow('Mark-lost termination was not verified at its boundary');

    await expectNoPartialMutation(storage, spec);
  });

  it('rejects a receipt pinned to a superseded lease incarnation', async () => {
    const { storage, lease, spec, request } = await prepare();
    const receipt = mintEligibilityReceipt({ lease, request });
    const boundary = new MarkLostBoundary(new Clock(NOW));
    const termination = boundary.verify({ receipt, lease });

    expect(await storage.releaseTaskLease(lease)).toBe(true);
    const newLease = await storage.acquireTaskLease({
      scope: spec.task,
      ownerId: lease.ownerId,
      leaseDurationMs: 60_000,
    });
    expect(newLease.fence).toBeGreaterThan(lease.fence);

    // The re-acquired lease is itself perfectly valid, so a stale-lease check
    // would not fire here -- only the eligibility fence baked into the
    // receipt can distinguish it from the incarnation eligibility was
    // decided under.
    await expect(
      storage.terminateLostAttempt({ lease: newLease, termination }),
    ).rejects.toThrow('Mark-lost eligibility fence is invalid');

    await expectNoPartialMutation(storage, spec);
  });

  it('rejects when the Attempt advanced after eligibility was decided', async () => {
    const { storage, lease, spec, request } = await prepare();
    const stored = requireAttempt(storage, spec.attemptId);
    stored.revision += 1;

    await expect(
      terminateComposition({ storage, lease, request }),
    ).rejects.toThrow('Mark-lost contradicts current Attempt');

    await expectNoPartialMutation(storage, spec);
  });

  it('rejects when the live run binding differs from the receipt', async () => {
    const { storage, lease, spec, request } = await prepare();
    const stored = requireAttempt(storage, spec.attemptId);
    if (stored.binding === undefined) throw new Error('missing binding');
    stored.binding = { ...stored.binding, runId: stored.binding.runId + 1 };

    // The shadow Attempt-history head is cross-checked against the legacy
    // Attempt on every mark-lost commit attempt (via the finalization
    // lineage guard), and it still reflects the original binding -- so that
    // general integrity guard fires before the mark-lost-specific binding
    // comparison ever runs.
    await expect(
      terminateComposition({ storage, lease, request }),
    ).rejects.toThrow('Attempt history head conflicts with legacy Attempt');

    await expectNoPartialMutation(storage, spec);
  });

  it('rejects when the Attempt already has terminal execution evidence', async () => {
    const { storage, lease, spec, request } = await prepare();
    const stored = requireAttempt(storage, spec.attemptId);
    if (stored.binding === undefined) throw new Error('missing binding');
    stored.pendingTerminal = {
      factId: 'pending-terminal-fact',
      binding: stored.binding,
      conclusion: 'success',
      observedAt: NOW,
      finalizationDeadline: NOW,
    };

    await expect(
      terminateComposition({ storage, lease, request }),
    ).rejects.toThrow('Mark-lost contradicts current Attempt');

    await expectNoPartialMutation(storage, spec);
  });

  it('rejects when the launch is no longer accepted', async () => {
    const { storage, lease, spec, request } = await prepare();
    const launch = internals(storage).launches.get(spec.attemptId);
    if (launch === undefined) throw new Error('missing launch');
    launch.state = 'suppressed';

    await expect(
      terminateComposition({ storage, lease, request }),
    ).rejects.toThrow('Mark-lost contradicts current Attempt');

    await expectNoPartialMutation(storage, spec);
  });

  it('rejects when future grants are already denied', async () => {
    const { storage, lease, spec, request } = await prepare();
    const stored = requireAttempt(storage, spec.attemptId);
    stored.futureGrantsDenied = true;

    await expect(
      terminateComposition({ storage, lease, request }),
    ).rejects.toThrow('Mark-lost contradicts current Attempt');

    await expectNoPartialMutation(storage, spec);
  });

  it('rejects when the bounded baseline fact no longer matches the receipt', async () => {
    const { storage, lease, spec, request } = await prepare();
    const history = internals(storage).attemptHistories.get(spec.attemptId);
    if (history === undefined) throw new Error('missing Attempt history');
    const factEntries = history.records.get('fact') ?? [];
    const baseline = factEntries.find(
      (entry) =>
        (entry.payload.payload as { kind?: string } | undefined)?.kind ===
        'run-bound',
    );
    if (baseline === undefined) {
      throw new Error('missing run-bound baseline fact record');
    }
    const factPayload = baseline.payload.payload as {
      binding: { runId: number };
    };
    factPayload.binding = {
      ...factPayload.binding,
      runId: factPayload.binding.runId + 1,
    };

    // The mutated payload no longer hashes to the record's stored
    // payloadDigest, so this is caught by the durable-history integrity
    // check re-run on every commit attempt, before the mark-lost-specific
    // baseline comparison would even get a chance to run.
    await expect(
      terminateComposition({ storage, lease, request }),
    ).rejects.toThrow('Attempt history integrity failed');

    await expectNoPartialMutation(storage, spec);
  });

  it('rejects when the Attempt has no bounded history', async () => {
    const { storage, lease, spec, request } = await prepare();
    const value = internals(storage);
    // Mirror `deleteAttemptHistoryLineage` from
    // launch-rejection-history.in-memory.spec.support.ts: clearing every
    // lineage map, not just `attemptHistories`, keeps the admission-lineage
    // guard's early return intact so it does not fire ahead of the
    // bounded-history check this test targets.
    value.attemptHistories.delete(spec.attemptId);
    value.taskHistories.clear();
    value.acceptances.clear();
    for (const [key, receipt] of value.attemptAdmissionHistoryReceipts) {
      if (receipt.attemptId === spec.attemptId) {
        value.attemptAdmissionHistoryReceipts.delete(key);
      }
    }

    await expect(
      terminateComposition({ storage, lease, request }),
    ).rejects.toThrow('Mark-lost requires bounded Attempt history');

    await expectNoPartialMutation(storage, spec);
  });
});
