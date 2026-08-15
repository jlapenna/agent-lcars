import type { RuntimeObservationEnvelope } from '@agent-lcars/dispatch-contracts';
import { runtimeObservationPayloadSha256 } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  type AttemptPresentationRecord,
  type AuthorityClock,
  AuthorityConflict,
  InMemoryLifecycleAuthorityStorage,
} from './authority-storage';
import { inMemoryTerminalClaimHistoryHooks } from './terminal-claim-history.in-memory.spec.support';
import {
  AttemptFinalizer,
  ClaimObservationBoundary,
  isVerifiedClaimObservation,
  isVerifiedTerminalObservation,
  TerminalFinalizerConflict,
  TerminalObservationBoundary,
} from './terminal-finalizer';
import { inMemoryValidationHistoryHooks } from './validation-history.in-memory.spec.support';

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

async function envelope(
  payload: RuntimeObservationEnvelope['payload'],
  overrides: Partial<RuntimeObservationEnvelope> = {},
): Promise<RuntimeObservationEnvelope> {
  return {
    schema: 'agent-lcars.runtime-observation/v1',
    version: 1,
    requestId: 'request-1',
    factId: 'fact-1',
    attemptId: 'A'.repeat(22),
    tenant,
    task,
    source: { kind: 'github-provider', sourceId: 'source-1' },
    observedAt: '2026-08-16T00:00:00.000Z',
    payloadSha256: await runtimeObservationPayloadSha256(payload),
    payload,
    ...overrides,
  };
}

import {
  activeFixture,
  evidenceVerifier,
  runAttemptFinalizerStorageContract,
} from './terminal-finalizer.spec.support';

describe('terminal finalizer trust boundaries', () => {
  it('requires provider terminal attestation and returns a recursively immutable capability', async () => {
    const verifier = {
      verifyTerminal: vi.fn(async () => ({
        observedAt: '2026-08-16T00:00:00.000Z',
        finalizationDeadline: DEADLINE,
      })),
      verifyClaim: vi.fn(async () => ({
        observedAt: '2026-08-16T00:00:00.000Z',
      })),
    };
    const boundary = new TerminalObservationBoundary(verifier);
    const terminal = await boundary.verify({
      envelope: await envelope({
        kind: 'run-terminal',
        binding,
        conclusion: 'success',
        observedAt: '2026-08-16T00:00:00.000Z',
      }),
    });

    expect(isVerifiedTerminalObservation(terminal)).toBe(true);
    expect(verifier.verifyTerminal).toHaveBeenCalledOnce();
    expect(Object.isFrozen(terminal.envelope.tenant)).toBe(true);
    expect(() => {
      (terminal.envelope.tenant as { tenantId: string }).tenantId = 'other';
    }).toThrow(TypeError);
  });

  it('authenticates claim transport without treating the deliverable as attested', async () => {
    const verifier = {
      verifyTerminal: vi.fn(async () => ({
        observedAt: '2026-08-16T00:00:00.000Z',
        finalizationDeadline: DEADLINE,
      })),
      verifyClaim: vi.fn(async () => ({
        observedAt: '2026-08-16T00:00:00.000Z',
      })),
    };
    const boundary = new ClaimObservationBoundary(verifier);
    const claim = await boundary.parse({
      envelope: await envelope({
        kind: 'agent-result-claim',
        claim: {
          kind: 'comment',
          commentId: 'comment-1',
          localAttemptMarker: 'g1:intent-1',
        },
      }),
    });
    expect(isVerifiedClaimObservation(claim)).toBe(true);
    expect(verifier.verifyClaim).toHaveBeenCalledWith(claim);
    await expect(
      boundary.parse({
        envelope: { ...claim.envelope, payloadSha256: 'b'.repeat(64) },
      }),
    ).rejects.toBeInstanceOf(TerminalFinalizerConflict);
  });

  it('uses only attested deadline and receipt time, ignoring backdated caller metadata', async () => {
    const verifier = {
      verifyTerminal: vi.fn(async () => ({
        observedAt: '2026-08-16T00:00:00.000Z',
        finalizationDeadline: DEADLINE,
      })),
      verifyClaim: vi.fn(async () => ({ observedAt: FINAL_TIME })),
    };
    const terminalBoundary = new TerminalObservationBoundary(verifier);
    const terminal = await terminalBoundary.verify({
      envelope: await envelope({
        kind: 'run-terminal',
        binding,
        conclusion: 'success',
        observedAt: '2026-08-15T00:00:00.000Z',
      }),
      // An untrusted extra property cannot shorten the policy-owned window.
      finalizationDeadline: '2026-08-16T00:00:01.000Z',
    } as { envelope: unknown });
    expect(terminal.finalizationDeadline).toBe(DEADLINE);
    expect(terminal.envelope.payload).toMatchObject({
      observedAt: '2026-08-16T00:00:00.000Z',
    });

    const claim = await new ClaimObservationBoundary(verifier).parse({
      envelope: await envelope(
        {
          kind: 'agent-result-claim',
          claim: {
            kind: 'comment',
            commentId: 'comment-backdated',
            localAttemptMarker: 'g1:intent-1',
          },
        },
        { observedAt: '2026-08-15T00:00:00.000Z' },
      ),
    });
    expect(claim.envelope.observedAt).toBe(FINAL_TIME);
  });
});

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

describe('in-memory finalization presentation receipt integrity', () => {
  it.each(['missing', 'changed'] as const)(
    'rejects exact finalization replay when its live plan is %s',
    async (corruption) => {
      const clock = new ManualClock();
      const storage = new InMemoryLifecycleAuthorityStorage(clock, {
        mint: () => 'A'.repeat(22),
      });
      const { lease, spec } = await activeFixture(storage);
      const finalizer = new AttemptFinalizer(storage, clock, {
        async resolve() {
          return { status: 'validated' as const };
        },
      });
      const terminal = await new TerminalObservationBoundary(
        evidenceVerifier(),
      ).verify({
        envelope: await envelope(
          {
            kind: 'run-terminal',
            binding,
            conclusion: 'success',
            observedAt: '2026-08-16T00:00:00.000Z',
          },
          {
            requestId: `request-terminal-corrupt-${corruption}`,
            factId: `fact-terminal-corrupt-${corruption}`,
          },
        ),
      });
      await finalizer.recordObservation(lease, terminal);
      clock.set(DEADLINE);
      await finalizer.beginValidation(lease, tenant.tenantId, spec.attemptId);
      clock.set(FINAL_TIME);
      await finalizer.finalize(lease, tenant.tenantId, spec.attemptId);

      // Deliberate adapter corruption proves replay checks the durable record,
      // not merely the existence/count of a presentation operation.
      const internals = storage as unknown as {
        attemptPresentations: Map<string, AttemptPresentationRecord>;
      };
      if (corruption === 'missing') {
        internals.attemptPresentations.clear();
      } else {
        const entry = [...internals.attemptPresentations.entries()][0];
        if (entry === undefined) throw new Error('Expected presentation plan');
        entry[1].plan.outcomeDigest = 'b'.repeat(64);
      }
      await expect(
        finalizer.finalize(lease, tenant.tenantId, spec.attemptId),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      expect(
        (
          await storage.readAttempt({
            tenantId: tenant.tenantId,
            attemptId: spec.attemptId,
          })
        )?.phase,
      ).toBe('terminal');
    },
  );
});

runAttemptFinalizerStorageContract(
  (clock) =>
    new InMemoryLifecycleAuthorityStorage(clock, {
      mint: () => 'A'.repeat(22),
    }),
  inMemoryTerminalClaimHistoryHooks(),
  inMemoryValidationHistoryHooks(),
);
