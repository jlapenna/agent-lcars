import type { RuntimeObservationEnvelope } from '@agent-lcars/dispatch-contracts';
import { runtimeObservationPayloadSha256 } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import { attemptTransitionDigest, reduceAttempt } from './attempt-reducer';
import { hydrateAttemptForTest } from './attempt-test-hydration';
import type {
  AuthorityClock,
  LifecycleAuthorityStorage,
} from './authority-storage';
import { AuthorityConflict } from './authority-storage';
import {
  finalizationCommandId,
  mintFinalizationTransition,
} from './finalization-capability';
import {
  AttemptFinalizer,
  ClaimObservationBoundary,
  TerminalObservationBoundary,
} from './terminal-finalizer';
import {
  activeFixture,
  evidenceVerifier,
} from './terminal-finalizer.spec.support';
import type {
  ValidationHistoryCorruption,
  ValidationHistoryStorageHooks,
} from './validation-history.in-memory.spec.support';

const TENANT_ID = 'tenant-1';
const ATTEMPT_ID = 'A'.repeat(22);
const DEADLINE = '2026-08-16T00:05:00.000Z';
const BEFORE_DEADLINE = '2026-08-16T00:04:59.000Z';

class ValidationClock implements AuthorityClock {
  constructor(private value = '2026-08-16T00:00:00.000Z') {}
  now(): string {
    return this.value;
  }
  set(value: string): void {
    this.value = value;
  }
}

async function terminalEnvelope(
  overrides: Record<string, unknown> = {},
): Promise<RuntimeObservationEnvelope> {
  const value = {
    schema: 'agent-lcars.runtime-observation/v1' as const,
    version: 1 as const,
    requestId: 'request-validation-terminal',
    factId: 'fact-validation-terminal',
    attemptId: ATTEMPT_ID,
    tenant: {
      tenantId: TENANT_ID,
      repositoryId: 123,
      repository: 'octo/example',
      installationId: 456,
    },
    task: { tenantId: TENANT_ID, repositoryId: 123, issueNumber: 9 },
    source: { kind: 'github-provider' as const, sourceId: 'source-validation' },
    observedAt: '2026-08-16T00:00:00.000Z',
    payloadSha256: '',
    payload: {
      kind: 'run-terminal' as const,
      binding: {
        runId: 10,
        runAttempt: 1,
        checkRunId: 11,
        workflowPath: '.github/workflows/worker.yml',
        workflowRef: 'refs/heads/main',
        workflowSha: 'c'.repeat(40),
      },
      conclusion: 'success' as const,
      observedAt: '2026-08-16T00:00:00.000Z',
    },
    ...overrides,
  };
  return {
    ...value,
    payloadSha256: await runtimeObservationPayloadSha256(value.payload),
  } as RuntimeObservationEnvelope;
}

async function setup(
  makeStorage: (
    clock: AuthorityClock,
  ) => LifecycleAuthorityStorage | Promise<LifecycleAuthorityStorage>,
  claimCount: number,
) {
  const clock = new ValidationClock();
  const storage = await makeStorage(clock);
  const { lease, spec } = await activeFixture(storage);
  const verifier = evidenceVerifier();
  const finalizer = new AttemptFinalizer(storage, clock, {
    resolve: async () => ({ status: 'validated' as const }),
  });
  const terminal = await new TerminalObservationBoundary(verifier).verify({
    envelope: await terminalEnvelope(),
  });
  await finalizer.recordObservation(lease, terminal);
  const claims: string[] = [];
  for (let index = 0; index < claimCount; index += 1) {
    const factId = `fact-validation-claim-${index}`;
    claims.push(factId);
    const claim = await new ClaimObservationBoundary(verifier).parse({
      envelope: await terminalEnvelope({
        requestId: `request-validation-claim-${index}`,
        factId,
        payload: {
          kind: 'agent-result-claim' as const,
          claim: {
            kind: 'comment' as const,
            commentId: `comment-validation-${index}`,
            localAttemptMarker: spec.local.attemptMarker,
          },
        },
      }),
    });
    await finalizer.recordObservation(lease, claim);
  }
  clock.set(DEADLINE);
  return { clock, storage, lease, spec, finalizer, claims };
}

function streamLength(
  history: Awaited<
    ReturnType<ValidationHistoryStorageHooks['readAttemptHistory']>
  >,
  stream: 'command' | 'validation',
): number {
  return history?.records[stream].length ?? 0;
}

function firstClaim(claims: readonly string[]): string {
  const claim = claims[0];
  if (claim === undefined) throw new Error('missing validation claim');
  return claim;
}

/** Every backend must pass the validation-history transaction contract. */
export function runValidationHistoryStorageContract(
  makeStorage: (
    clock: AuthorityClock,
  ) => LifecycleAuthorityStorage | Promise<LifecycleAuthorityStorage>,
  hooks: ValidationHistoryStorageHooks,
): void {
  describe('attempt validation history storage contract', () => {
    it.each([0, 1, 3])(
      'starts validation with exactly one command and %s pending work rows',
      async (claimCount) => {
        const value = await setup(makeStorage, claimCount);
        const before = await hooks.readAttemptHistory(value.storage, {
          lease: value.lease,
          tenantId: TENANT_ID,
          attemptId: ATTEMPT_ID,
        });
        expect(
          await value.finalizer.beginValidation(
            value.lease,
            TENANT_ID,
            ATTEMPT_ID,
          ),
        ).toBe('applied');
        const after = await hooks.readAttemptHistory(value.storage, {
          lease: value.lease,
          tenantId: TENANT_ID,
          attemptId: ATTEMPT_ID,
        });
        expect(streamLength(after, 'command')).toBe(
          streamLength(before, 'command') + 1,
        );
        expect(after?.records.validation).toHaveLength(0);
        expect(after?.head.phase).toBe('validating');
        expect(after?.head.finalization?.validationRefs).toEqual([]);
        const startCommand = after?.records.command.find(
          (entry) => entry.payload.payload?.kind === 'start-validation',
        );
        expect(startCommand?.record.recordDigest).toMatch(/^[a-f0-9]{64}$/u);
        expect(startCommand?.payload.canonicalDigest).toMatch(
          /^[a-f0-9]{64}$/u,
        );
        expect(startCommand?.payload.payload?.terminalFactRef).toEqual(
          after?.head.finalization?.terminalFactRef,
        );
        expect(
          await value.storage.listValidationWork({
            tenantId: TENANT_ID,
            state: 'pending',
          }),
        ).toHaveLength(claimCount);
        expect(
          await value.storage.listAttemptPresentations({
            tenantId: TENANT_ID,
            attemptId: ATTEMPT_ID,
          }),
        ).toEqual([]);
      },
    );

    it('accepts the exact deadline, rejects early start, and exact-replays without duplicate work', async () => {
      const value = await setup(makeStorage, 1);
      value.clock.set(BEFORE_DEADLINE);
      await expect(
        value.finalizer.beginValidation(value.lease, TENANT_ID, ATTEMPT_ID),
      ).rejects.toThrow('Validation window');
      value.clock.set(DEADLINE);
      expect(
        await value.finalizer.beginValidation(
          value.lease,
          TENANT_ID,
          ATTEMPT_ID,
        ),
      ).toBe('applied');
      expect(
        await value.finalizer.beginValidation(
          value.lease,
          TENANT_ID,
          ATTEMPT_ID,
        ),
      ).toBe('replay');
      expect(
        await value.storage.listValidationWork({
          tenantId: TENANT_ID,
          state: 'pending',
        }),
      ).toHaveLength(1);
    });

    it.each([
      { status: 'validated' as const },
      { status: 'rejected' as const, reason: 'marker-mismatch' as const },
      { status: 'rejected' as const, reason: 'reference-mismatch' as const },
    ])(
      'records a closed verdict with exact command, validation refs, and frozen selection: %o',
      async (verdict) => {
        const value = await setup(makeStorage, 1);
        const selectionSeen: unknown[] = [];
        const finalizer = new AttemptFinalizer(value.storage, value.clock, {
          resolve: async (selection) => {
            selectionSeen.push(selection);
            return verdict;
          },
        });
        await finalizer.beginValidation(value.lease, TENANT_ID, ATTEMPT_ID);
        expect(
          await finalizer.resolveClaim(
            value.lease,
            TENANT_ID,
            ATTEMPT_ID,
            firstClaim(value.claims),
          ),
        ).toBe('applied');
        expect(selectionSeen).toHaveLength(1);
        expect(Object.isFrozen(selectionSeen[0])).toBe(true);
        const selection = selectionSeen[0] as {
          spec: unknown;
          claim: unknown;
        };
        expect(Object.isFrozen(selection.spec)).toBe(true);
        expect(Object.isFrozen(selection.claim)).toBe(true);
        const history = await hooks.readAttemptHistory(value.storage, {
          lease: value.lease,
          tenantId: TENANT_ID,
          attemptId: ATTEMPT_ID,
        });
        expect(history?.records.validation).toHaveLength(1);
        const validationCommand = history?.records.command.find(
          (entry) => entry.payload.payload?.kind === 'validate-claim-requested',
        );
        expect(validationCommand).toBeDefined();
        expect(validationCommand?.record.recordDigest).toMatch(
          /^[a-f0-9]{64}$/u,
        );
        expect(validationCommand?.payload.canonicalDigest).toMatch(
          /^[a-f0-9]{64}$/u,
        );
        expect(history?.records.validation[0]?.payload).toMatchObject({
          commandId: validationCommand?.payload.payload?.commandId,
          validationFactId: validationCommand?.payload.payload?.commandId,
          terminalFactRef: validationCommand?.payload.payload?.terminalFactRef,
          claimFactRef: validationCommand?.payload.payload?.claimFactRef,
          validation: verdict,
        });
        expect(history?.records.validation[0]?.record.recordDigest).toMatch(
          /^[a-f0-9]{64}$/u,
        );
        expect(
          history?.head.finalization?.validationRefs[0]?.recordDigest,
        ).toBe(history?.records.validation[0]?.record.recordDigest);
        expect(
          await value.storage.listValidationWork({
            tenantId: TENANT_ID,
            state: 'complete',
          }),
        ).toMatchObject([
          {
            claimFactId: value.claims[0],
            validationFactId: expect.any(String),
          },
        ]);
        expect(
          await value.storage.listAttemptPresentations({
            tenantId: TENANT_ID,
            attemptId: ATTEMPT_ID,
          }),
        ).toEqual([]);
      },
    );

    it('supports partial multi-claim progress with exact refs and no outcome side effects', async () => {
      const value = await setup(makeStorage, 3);
      await value.finalizer.beginValidation(value.lease, TENANT_ID, ATTEMPT_ID);
      expect(
        await value.finalizer.resolveClaim(
          value.lease,
          TENANT_ID,
          ATTEMPT_ID,
          firstClaim(value.claims),
        ),
      ).toBe('applied');
      const history = await hooks.readAttemptHistory(value.storage, {
        lease: value.lease,
        tenantId: TENANT_ID,
        attemptId: ATTEMPT_ID,
      });
      expect(history?.records.validation).toHaveLength(1);
      expect(history?.head.finalization?.validationRefs).toHaveLength(1);
      expect(
        await value.storage.listValidationWork({
          tenantId: TENANT_ID,
          state: 'pending',
        }),
      ).toHaveLength(2);
      expect(
        await value.storage.listValidationWork({
          tenantId: TENANT_ID,
          state: 'complete',
        }),
      ).toHaveLength(1);
      expect(
        (
          await value.storage.readAttempt({
            tenantId: TENANT_ID,
            attemptId: ATTEMPT_ID,
          })
        )?.outcome,
      ).toBeUndefined();
    });

    it('leaves history/work unchanged on resolver throw, then permits a higher-fence takeover', async () => {
      const value = await setup(makeStorage, 1);
      await value.finalizer.beginValidation(value.lease, TENANT_ID, ATTEMPT_ID);
      const failing = new AttemptFinalizer(value.storage, value.clock, {
        resolve: async () => {
          throw new Error('provider unavailable');
        },
      });
      await expect(
        failing.resolveClaim(
          value.lease,
          TENANT_ID,
          ATTEMPT_ID,
          firstClaim(value.claims),
        ),
      ).rejects.toThrow('provider unavailable');
      expect(
        await hooks.readAttemptHistory(value.storage, {
          lease: value.lease,
          tenantId: TENANT_ID,
          attemptId: ATTEMPT_ID,
        }),
      ).toMatchObject({ records: { validation: [] } });
      expect(
        await value.storage.listValidationWork({
          tenantId: TENANT_ID,
          state: 'resolving',
        }),
      ).toHaveLength(1);
      await value.storage.releaseTaskLease(value.lease);
      const takeover = await value.storage.acquireTaskLease({
        scope: { tenantId: TENANT_ID, repositoryId: 123, issueNumber: 9 },
        ownerId: 'takeover',
        leaseDurationMs: 60 * 60 * 1000,
      });
      const recovered = new AttemptFinalizer(value.storage, value.clock, {
        resolve: async () => ({ status: 'validated' as const }),
      });
      expect(
        await recovered.resolveClaim(
          takeover,
          TENANT_ID,
          ATTEMPT_ID,
          firstClaim(value.claims),
        ),
      ).toBe('applied');
      expect(
        await value.storage.listValidationWork({
          tenantId: TENANT_ID,
          state: 'complete',
        }),
      ).toHaveLength(1);
    });

    it('rejects stale claimant fence/token and exact-replays a completed result', async () => {
      const value = await setup(makeStorage, 1);
      await value.finalizer.beginValidation(value.lease, TENANT_ID, ATTEMPT_ID);
      await expect(
        value.storage.claimValidationWork({
          lease: { ...value.lease, fence: value.lease.fence - 1 },
          tenantId: TENANT_ID,
          attemptId: ATTEMPT_ID,
          terminalFactId: 'fact-validation-terminal',
          claimFactId: firstClaim(value.claims),
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      expect(
        await value.finalizer.resolveClaim(
          value.lease,
          TENANT_ID,
          ATTEMPT_ID,
          firstClaim(value.claims),
        ),
      ).toBe('applied');
      expect(
        await value.finalizer.resolveClaim(
          value.lease,
          TENANT_ID,
          ATTEMPT_ID,
          firstClaim(value.claims),
        ),
      ).toBe('replay');
    });

    it('rejects a changed verdict for an already recorded validation command', async () => {
      const value = await setup(makeStorage, 1);
      await value.finalizer.beginValidation(value.lease, TENANT_ID, ATTEMPT_ID);
      expect(
        await value.finalizer.resolveClaim(
          value.lease,
          TENANT_ID,
          ATTEMPT_ID,
          firstClaim(value.claims),
        ),
      ).toBe('applied');
      await expect(
        value.storage.applyFinalizationTransition({
          lease: value.lease,
          transition: mintFinalizationTransition({
            kind: 'validate-claim',
            tenantId: TENANT_ID,
            attemptId: ATTEMPT_ID,
            claimFactId: firstClaim(value.claims),
            validationFactId: finalizationCommandId(
              'validate-claim',
              ATTEMPT_ID,
              'fact-validation-terminal',
              firstClaim(value.claims),
            ),
            at: value.clock.now(),
            verdict: {
              status: 'rejected',
              reason: 'marker-mismatch',
            },
          }),
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);
    });

    it('replays a completed validation after later legacy progress without changing history', async () => {
      const value = await setup(makeStorage, 1);
      await value.finalizer.beginValidation(value.lease, TENANT_ID, ATTEMPT_ID);
      expect(
        await value.finalizer.resolveClaim(
          value.lease,
          TENANT_ID,
          ATTEMPT_ID,
          firstClaim(value.claims),
        ),
      ).toBe('applied');
      const before = await hooks.readAttemptHistory(value.storage, {
        lease: value.lease,
        tenantId: TENANT_ID,
        attemptId: ATTEMPT_ID,
      });
      const current = await value.storage.readAttempt({
        tenantId: TENANT_ID,
        attemptId: ATTEMPT_ID,
      });
      if (current === undefined) throw new Error('missing Attempt');
      const heartbeatEnvelope = await terminalEnvelope({
        requestId: 'request-validation-heartbeat',
        factId: 'fact-validation-heartbeat',
        payload: {
          kind: 'heartbeat' as const,
          grantId: 'grant-validation-heartbeat',
          at: '2026-08-16T00:06:00.000Z',
          phase: 'agent-execution' as const,
        },
      });
      const progressed = reduceAttempt(current, {
        kind: 'transition',
        expectedRevision: current.revision,
        transitionedAt: '2026-08-16T00:06:00.000Z',
        canonicalDigest: attemptTransitionDigest({
          kind: 'observation',
          envelope: heartbeatEnvelope,
        }),
        event: { kind: 'observation', envelope: heartbeatEnvelope },
      });
      if (progressed.status !== 'applied')
        throw new Error('legacy progress was not applied');
      await hydrateAttemptForTest(value.storage, {
        lease: value.lease,
        expectedRevision: current.revision,
        next: progressed.state,
      });
      expect(
        await value.finalizer.resolveClaim(
          value.lease,
          TENANT_ID,
          ATTEMPT_ID,
          firstClaim(value.claims),
        ),
      ).toBe('replay');
      await expect(
        hooks.readAttemptHistory(value.storage, {
          lease: value.lease,
          tenantId: TENANT_ID,
          attemptId: ATTEMPT_ID,
        }),
      ).resolves.toEqual(before);
    });

    it.each([
      'head',
      'terminal-lineage',
      'claim-lineage',
      'work',
      'start-command',
      'validation-command',
      'validation-record',
      'validation-ref',
      'private-receipt',
    ] as ValidationHistoryCorruption[])(
      'fails closed on independent validation corruption: %s',
      async (corruption) => {
        const value = await setup(makeStorage, 1);
        await value.finalizer.beginValidation(
          value.lease,
          TENANT_ID,
          ATTEMPT_ID,
        );
        await value.finalizer.resolveClaim(
          value.lease,
          TENANT_ID,
          ATTEMPT_ID,
          firstClaim(value.claims),
        );
        const attemptBefore = await value.storage.readAttempt({
          tenantId: TENANT_ID,
          attemptId: ATTEMPT_ID,
        });
        hooks.corruptValidationHistory(value.storage, corruption);
        await expect(
          value.finalizer.resolveClaim(
            value.lease,
            TENANT_ID,
            ATTEMPT_ID,
            firstClaim(value.claims),
          ),
        ).rejects.toBeInstanceOf(AuthorityConflict);
        await expect(
          value.storage.readAttempt({
            tenantId: TENANT_ID,
            attemptId: ATTEMPT_ID,
          }),
        ).resolves.toEqual(attemptBefore);
      },
    );

    it('rolls back start-validation history/work atomically when the final history commit fails', async () => {
      const value = await setup(makeStorage, 2);
      const before = await hooks.readAttemptHistory(value.storage, {
        lease: value.lease,
        tenantId: TENANT_ID,
        attemptId: ATTEMPT_ID,
      });
      const attemptBefore = await value.storage.readAttempt({
        tenantId: TENANT_ID,
        attemptId: ATTEMPT_ID,
      });
      const restore = hooks.failValidationHistoryCommit(value.storage);
      try {
        await expect(
          value.finalizer.beginValidation(value.lease, TENANT_ID, ATTEMPT_ID),
        ).rejects.toThrow('history');
      } finally {
        restore();
      }
      await expect(
        value.storage.readAttempt({
          tenantId: TENANT_ID,
          attemptId: ATTEMPT_ID,
        }),
      ).resolves.toEqual(attemptBefore);
      await expect(
        hooks.readAttemptHistory(value.storage, {
          lease: value.lease,
          tenantId: TENANT_ID,
          attemptId: ATTEMPT_ID,
        }),
      ).resolves.toEqual(before);
      expect(
        await value.storage.listValidationWork({
          tenantId: TENANT_ID,
          state: 'pending',
        }),
      ).toHaveLength(0);
    });

    it('rolls back validation result history/work atomically when the final history commit fails', async () => {
      const value = await setup(makeStorage, 1);
      await value.finalizer.beginValidation(value.lease, TENANT_ID, ATTEMPT_ID);
      const before = await hooks.readAttemptHistory(value.storage, {
        lease: value.lease,
        tenantId: TENANT_ID,
        attemptId: ATTEMPT_ID,
      });
      const restore = hooks.failValidationHistoryCommit(value.storage);
      try {
        await expect(
          value.finalizer.resolveClaim(
            value.lease,
            TENANT_ID,
            ATTEMPT_ID,
            firstClaim(value.claims),
          ),
        ).rejects.toThrow('history');
      } finally {
        restore();
      }
      await expect(
        hooks.readAttemptHistory(value.storage, {
          lease: value.lease,
          tenantId: TENANT_ID,
          attemptId: ATTEMPT_ID,
        }),
      ).resolves.toEqual(before);
      expect(
        await value.storage.listValidationWork({
          tenantId: TENANT_ID,
          state: 'resolving',
        }),
      ).toHaveLength(1);
      await value.storage.releaseTaskLease(value.lease);
      const takeover = await value.storage.acquireTaskLease({
        scope: { tenantId: TENANT_ID, repositoryId: 123, issueNumber: 9 },
        ownerId: 'validation-history-takeover',
        leaseDurationMs: 60 * 60 * 1000,
      });
      const recovered = new AttemptFinalizer(value.storage, value.clock, {
        resolve: async () => ({ status: 'validated' as const }),
      });
      expect(
        await recovered.resolveClaim(
          takeover,
          TENANT_ID,
          ATTEMPT_ID,
          firstClaim(value.claims),
        ),
      ).toBe('applied');
    });

    it('rejects a fresh validation when its private start receipt is corrupted before work mutation', async () => {
      const value = await setup(makeStorage, 1);
      await value.finalizer.beginValidation(value.lease, TENANT_ID, ATTEMPT_ID);
      const before = await hooks.readAttemptHistory(value.storage, {
        lease: value.lease,
        tenantId: TENANT_ID,
        attemptId: ATTEMPT_ID,
      });
      const attemptBefore = await value.storage.readAttempt({
        tenantId: TENANT_ID,
        attemptId: ATTEMPT_ID,
      });
      hooks.corruptValidationHistory(value.storage, 'private-receipt');
      await expect(
        value.finalizer.resolveClaim(
          value.lease,
          TENANT_ID,
          ATTEMPT_ID,
          firstClaim(value.claims),
        ),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      await expect(
        value.storage.readAttempt({
          tenantId: TENANT_ID,
          attemptId: ATTEMPT_ID,
        }),
      ).resolves.toEqual(attemptBefore);
      await expect(
        hooks.readAttemptHistory(value.storage, {
          lease: value.lease,
          tenantId: TENANT_ID,
          attemptId: ATTEMPT_ID,
        }),
      ).resolves.toEqual(before);
      expect(
        await value.storage.listValidationWork({
          tenantId: TENANT_ID,
          state: 'pending',
        }),
      ).toHaveLength(1);
    });

    it('does not manufacture validation history when a legacy Attempt history is absent', async () => {
      const value = await setup(makeStorage, 1);
      hooks.deleteAttemptHistory(value.storage);
      await expect(
        value.finalizer.beginValidation(value.lease, TENANT_ID, ATTEMPT_ID),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      expect(
        await value.storage.listValidationWork({
          tenantId: TENANT_ID,
          state: 'pending',
        }),
      ).toHaveLength(0);
    });
  });
}
