import { createHash } from 'node:crypto';

import type {
  AcceptedAttemptSpec,
  ActivationRecord,
} from '@agent-lcars/dispatch-contracts';
import { runtimeObservationPayloadSha256 } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import type { AttemptHistoryInspection } from './attempt-history-test-support';
import { readAttemptHistoryForTest } from './attempt-history-test-support';
import type {
  AuthorityClock,
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
} from './authority-storage';
import { AuthorityConflict } from './authority-storage';
import { admitAcceptedSpecForTest } from './authority-storage-test-support';
import { CancellationTaskEffectCoordinator } from './cancellation-effects';
import {
  ingestVerifiedRunBinding,
  RunBindingIngressVerifier,
} from './launch-binding';
import { LaunchResolutionCoordinator } from './launch-resolution';
import { LaunchResponseBoundary } from './launch-resolution-capability';
import { writeAttemptForTest } from './launch-resolution-test-support';
import { launchedCancellationEffect } from './task-effects.spec.support';

const T0 = '2026-08-22T00:00:00.000Z';
const T1 = '2026-08-22T01:00:00.000Z';
const SHA = 'a'.repeat(64);
const tenant = {
  tenantId: 'tenant-launch',
  repositoryId: 818,
  repository: 'octo/launch',
  installationId: 919,
};
const task = {
  tenantId: tenant.tenantId,
  repositoryId: tenant.repositoryId,
  issueNumber: 6,
};
const cancellationTask = {
  tenantId: 'tenant-effects',
  repositoryId: 111,
  issueNumber: 3,
};
const bindingVerifier = new RunBindingIngressVerifier({
  async verifyExactRunBinding() {
    // Test verifier deliberately accepts the schema-checked exact binding.
  },
});

class Clock implements AuthorityClock {
  constructor(private value = T0) {}
  now(): string {
    return this.value;
  }
  set(value: string): void {
    this.value = value;
  }
}

function fixture(): {
  activation: ActivationRecord;
  spec: AcceptedAttemptSpec;
} {
  const activation: ActivationRecord = {
    schema: 'agent-lcars.control-plane-activation/v1',
    version: 1,
    tenant,
    taskClassId: 'github-issue',
    activationId: 'central-1',
    authorityEpoch: 1,
    effectiveBoundary: 1,
    mode: 'central-authoritative',
    effectMode: 'enabled',
    recordedAt: T0,
  };
  return {
    activation,
    spec: {
      schema: 'agent-lcars.attempt-spec/v1',
      version: 1,
      requestId: 'request-1',
      attemptId: 'A'.repeat(22),
      tenant,
      task,
      activation: {
        activationId: 'central-1',
        taskClassId: 'github-issue',
        authorityEpoch: 1,
        mode: 'central-authoritative',
      },
      local: {
        intentId: 'intent-1',
        generation: 1,
        attemptMarker: 'g1:intent-1',
        admissionRevision: 1,
        idempotencyKey: 'admit-1',
      },
      execution: {
        workflowPath: '.github/workflows/worker.yml',
        workflowRef: 'refs/heads/main',
        workflowSha: 'c'.repeat(40),
        mode: 'implement',
        executorId: 'executor-1',
        credentialProfileId: 'profile-1',
        renewalDeadline: '2026-08-22T06:00:00.000Z',
      },
      authorization: {
        schema: 'agent-lcars.policy-decision/v1',
        version: 1,
        policy: { policyId: 'policy-1', policyVersion: 1, contentSha256: SHA },
        decision: 'accepted',
        ruleId: 'rule-1',
        sourceFactId: 'fact-1',
        principal: { kind: 'system', systemId: 'system-1' },
        evidenceRef: 'evidence-1',
        decidedAt: T0,
      },
    },
  };
}

async function admitted(storage: LifecycleAuthorityStorage) {
  const value = fixture();
  const receipt = await admitAcceptedSpecForTest({
    storage,
    activation: value.activation,
    spec: value.spec,
  });
  return { ...value, lease: receipt.lease, spec: receipt.spec };
}

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

async function binding(spec: AcceptedAttemptSpec) {
  const payload = {
    kind: 'run-bound' as const,
    binding: {
      runId: 70,
      runAttempt: 1,
      checkRunId: 71,
      workflowPath: spec.execution.workflowPath,
      workflowRef: spec.execution.workflowRef,
      workflowSha: spec.execution.workflowSha,
    },
  };
  return bindingVerifier.verify({
    localAttemptMarker: spec.local.attemptMarker,
    envelope: {
      schema: 'agent-lcars.runtime-observation/v1',
      version: 1,
      requestId: 'request-bound',
      factId: 'fact-bound',
      attemptId: spec.attemptId,
      tenant: spec.tenant,
      task: spec.task,
      source: { kind: 'github-provider', sourceId: 'provider' },
      observedAt: T0,
      payloadSha256: await runtimeObservationPayloadSha256(payload),
      payload,
    },
  });
}

export interface LaunchResolutionStorageFactory {
  create(
    clock: AuthorityClock,
  ): LifecycleAuthorityStorage | Promise<LifecycleAuthorityStorage>;
}

/**
 * Test-only seams for the launch-resolution history contract.  Durable
 * adapters provide these hooks from their test harness; the authority port
 * intentionally exposes no history reader, corruption writer, or map.
 */
export interface LaunchResolutionHistoryStorageHooks {
  readAttemptHistory: typeof readAttemptHistoryForTest;
  deleteAttemptHistory(storage: LifecycleAuthorityStorage): void;
  deleteAdmissionLineage(storage: LifecycleAuthorityStorage): void;
  corruptLaunchResolutionReceipt(
    storage: LifecycleAuthorityStorage,
    kind: 'response' | 'command-ref' | 'missing-history',
  ): void;
  corruptLaunchResolutionHistoryRecord(
    storage: LifecycleAuthorityStorage,
    kind: 'payload' | 'digest',
  ): void;
  corruptLaunchResolutionHistoryHead(storage: LifecycleAuthorityStorage): void;
  corruptLaunchResolutionAdmission(
    storage: LifecycleAuthorityStorage,
    kind: 'receipt' | 'task-pointer',
  ): void;
  failLaunchResolutionHistoryCommit(
    storage: LifecycleAuthorityStorage,
  ): () => void;
  inspectLaunchResolutionInternals(storage: LifecycleAuthorityStorage): {
    attempts: number;
    launches: number;
    receipts: number;
    histories: number;
  };
}

export interface LaunchResolutionHistoryStorageFactory extends LaunchResolutionStorageFactory {
  historyHooks: LaunchResolutionHistoryStorageHooks;
}

async function readLaunchHistory(
  hooks: LaunchResolutionHistoryStorageHooks,
  storage: LifecycleAuthorityStorage,
  lease: TaskAuthorityLease,
  attemptId: string,
  tenantId = tenant.tenantId,
): Promise<AttemptHistoryInspection> {
  const history = await hooks.readAttemptHistory(storage, {
    lease,
    tenantId,
    attemptId,
  });
  if (history === undefined) throw new Error('missing Attempt history');
  return history;
}

/** Reusable async backend contract for provider-neutral verified launch work. */
export function runLaunchResolutionStorageContract(
  factory: LaunchResolutionStorageFactory,
): void {
  describe('verified launch-resolution storage contract', () => {
    it('claims once, atomically accepts, and rejects forged or changed results', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await admitted(storage);
      await expect(
        storage.resolveVerifiedLaunch({
          lease: value.lease,
          resolution: {} as never,
        }),
      ).rejects.toThrow(AuthorityConflict);
      const first = await storage.claimLaunchWork({
        lease: value.lease,
        tenantId: tenant.tenantId,
        attemptId: value.spec.attemptId,
      });
      expect(first.status).toBe('claimed');
      expect(
        (
          await storage.claimLaunchWork({
            lease: value.lease,
            tenantId: tenant.tenantId,
            attemptId: value.spec.attemptId,
          })
        ).status,
      ).toBe('replay');
      if (first.work === undefined) throw new Error('missing launch work');
      const boundary = new LaunchResponseBoundary(
        {
          resolve: async () => ({
            kind: 'accepted' as const,
            responseSha256: digest('response-a'),
          }),
        },
        clock,
      );
      const accepted = await boundary.resolve(first.work);
      expect(
        await storage.resolveVerifiedLaunch({
          lease: value.lease,
          resolution: accepted,
        }),
      ).toBe('applied');
      expect(
        await storage.resolveVerifiedLaunch({
          lease: value.lease,
          resolution: accepted,
        }),
      ).toBe('replay');
      const changed = await new LaunchResponseBoundary(
        {
          resolve: async () => ({
            kind: 'accepted' as const,
            responseSha256: digest('response-b'),
          }),
        },
        clock,
      ).resolve(first.work);
      await expect(
        storage.resolveVerifiedLaunch({
          lease: value.lease,
          resolution: changed,
        }),
      ).rejects.toThrow(AuthorityConflict);
      expect(
        (
          await storage.readLaunch({
            tenantId: tenant.tenantId,
            attemptId: value.spec.attemptId,
          })
        )?.state,
      ).toBe('accepted');
    });

    it('allows a later fence to reconcile unknown without invoking a response verifier', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await admitted(storage);
      await storage.claimLaunchWork({
        lease: value.lease,
        tenantId: tenant.tenantId,
        attemptId: value.spec.attemptId,
      });
      clock.set(T1);
      const later = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'later',
        leaseDurationMs: 60_000,
      });
      const takeover = await storage.claimLaunchWork({
        lease: later,
        tenantId: tenant.tenantId,
        attemptId: value.spec.attemptId,
      });
      if (takeover.work === undefined) throw new Error('missing takeover work');
      const verifier = {
        resolve: vi.fn(async () => ({
          kind: 'accepted' as const,
          responseSha256: digest('never'),
        })),
      };
      const coordinator = new LaunchResolutionCoordinator(
        storage,
        new LaunchResponseBoundary(verifier, clock),
        clock,
      );
      expect(
        await coordinator.resolve({ lease: later, work: takeover.work }),
      ).toBe('applied');
      expect(verifier.resolve).not.toHaveBeenCalled();
      expect(
        (
          await storage.readLaunch({
            tenantId: tenant.tenantId,
            attemptId: value.spec.attemptId,
          })
        )?.state,
      ).toBe('unknown');
    });

    it('fails closed before calling the response verifier when its clock is malformed', async () => {
      const storage = await factory.create(new Clock());
      const value = await admitted(storage);
      const claim = await storage.claimLaunchWork({
        lease: value.lease,
        tenantId: tenant.tenantId,
        attemptId: value.spec.attemptId,
      });
      if (claim.work === undefined) throw new Error('missing work');
      const verifier = {
        resolve: vi.fn(async () => ({
          kind: 'accepted' as const,
          responseSha256: digest('x'),
        })),
      };
      await expect(
        new LaunchResponseBoundary(verifier, {
          now: () => 'not-a-time',
        }).resolve(claim.work),
      ).rejects.toThrow('clock');
      expect(verifier.resolve).not.toHaveBeenCalled();
    });

    it('rejects foreign and expired authority without changing the launch record', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await admitted(storage);
      const foreign = await storage.acquireTaskLease({
        scope: { ...task, issueNumber: 7 },
        ownerId: 'foreign',
        leaseDurationMs: 60_000,
      });
      await expect(
        storage.claimLaunchWork({
          lease: foreign,
          tenantId: tenant.tenantId,
          attemptId: value.spec.attemptId,
        }),
      ).rejects.toThrow(AuthorityConflict);
      clock.set(T1);
      await expect(
        storage.claimLaunchWork({
          lease: value.lease,
          tenantId: tenant.tenantId,
          attemptId: value.spec.attemptId,
        }),
      ).rejects.toThrow(AuthorityConflict);
      expect(
        await storage.readLaunch({
          tenantId: tenant.tenantId,
          attemptId: value.spec.attemptId,
        }),
      ).toMatchObject({ state: 'pending' });
    });

    it('makes unknown terminal for dispatch and exposes no legacy structural writers', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await admitted(storage);
      const claim = await storage.claimLaunchWork({
        lease: value.lease,
        tenantId: tenant.tenantId,
        attemptId: value.spec.attemptId,
      });
      if (claim.work === undefined) throw new Error('missing work');
      const boundary = new LaunchResponseBoundary(
        {
          resolve: async () => ({
            kind: 'unknown' as const,
            responseSha256: digest('unknown-a'),
          }),
        },
        clock,
      );
      await storage.resolveVerifiedLaunch({
        lease: value.lease,
        resolution: await boundary.resolve(claim.work),
      });
      expect(
        await storage.claimLaunchWork({
          lease: value.lease,
          tenantId: tenant.tenantId,
          attemptId: value.spec.attemptId,
        }),
      ).toEqual({ status: 'terminal' });
      expect('claimLaunch' in storage).toBe(false);
      expect('resolveLaunch' in storage).toBe(false);
      expect('writeAttempt' in storage).toBe(false);
    });

    it('does not reclaim a bound dispatch record at a later fence', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await admitted(storage);
      await storage.claimLaunchWork({
        lease: value.lease,
        tenantId: tenant.tenantId,
        attemptId: value.spec.attemptId,
      });
      const current = await storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: value.spec.attemptId,
      });
      if (current === undefined) throw new Error('Attempt disappeared');
      await writeAttemptForTest({
        storage,
        lease: value.lease,
        expectedRevision: current.revision,
        next: {
          ...current,
          revision: current.revision + 1,
          binding: {
            runId: 80,
            runAttempt: 1,
            checkRunId: 81,
            workflowPath: value.spec.execution.workflowPath,
            workflowRef: value.spec.execution.workflowRef,
            workflowSha: value.spec.execution.workflowSha,
          },
        },
      });
      clock.set(T1);
      const later = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'later-bound',
        leaseDurationMs: 60_000,
      });
      await expect(
        storage.claimLaunchWork({
          lease: later,
          tenantId: tenant.tenantId,
          attemptId: value.spec.attemptId,
        }),
      ).rejects.toThrow(AuthorityConflict);
      expect(
        await storage.readLaunch({
          tenantId: tenant.tenantId,
          attemptId: value.spec.attemptId,
        }),
      ).toMatchObject({
        state: 'dispatching',
        claimedFence: value.lease.fence,
      });
    });

    it('keeps exact binding accepted when sealed delayed responses arrive', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await admitted(storage);
      const claim = await storage.claimLaunchWork({
        lease: value.lease,
        tenantId: tenant.tenantId,
        attemptId: value.spec.attemptId,
      });
      if (claim.work === undefined) throw new Error('missing work');
      await ingestVerifiedRunBinding(
        storage,
        value.lease,
        await binding(value.spec),
      );
      for (const kind of ['accepted', 'unknown'] as const) {
        const response = await new LaunchResponseBoundary(
          {
            resolve: async () => ({
              kind,
              responseSha256: digest(`late-${kind}`),
            }),
          },
          clock,
        ).resolve(claim.work);
        await expect(
          storage.resolveVerifiedLaunch({
            lease: value.lease,
            resolution: response,
          }),
        ).rejects.toThrow(AuthorityConflict);
      }
      expect(
        await storage.readLaunch({
          tenantId: tenant.tenantId,
          attemptId: value.spec.attemptId,
        }),
      ).toMatchObject({ state: 'accepted' });
      expect(
        await storage.readAttempt({
          tenantId: tenant.tenantId,
          attemptId: value.spec.attemptId,
        }),
      ).toMatchObject({ phase: 'active', binding: { runId: 70 } });
    });
  });
}

/** Reusable async contract for #1141 launch-resolution history shadowing. */
export function runLaunchResolutionHistoryStorageContract(
  factory: LaunchResolutionHistoryStorageFactory,
): void {
  const hooks = factory.historyHooks;

  describe('verified launch-resolution history storage contract', () => {
    it('records accepted and unknown commands and replays the exact response', async () => {
      for (const kind of ['accepted', 'unknown'] as const) {
        const clock = new Clock();
        const storage = await factory.create(clock);
        const value = await admitted(storage);
        const claim = await storage.claimLaunchWork({
          lease: value.lease,
          tenantId: tenant.tenantId,
          attemptId: value.spec.attemptId,
        });
        if (claim.work === undefined) throw new Error('missing launch work');
        const resolution = await new LaunchResponseBoundary(
          {
            resolve: async () => ({
              kind,
              responseSha256: digest(`history-${kind}`),
            }),
          },
          clock,
        ).resolve(claim.work);
        expect(
          await storage.resolveVerifiedLaunch({
            lease: value.lease,
            resolution,
          }),
        ).toBe('applied');
        const history = await readLaunchHistory(
          hooks,
          storage,
          value.lease,
          value.spec.attemptId,
        );
        expect(history.records.command).toHaveLength(2);
        expect(history.records.command[1]?.payload).toMatchObject({
          payload: {
            kind:
              kind === 'accepted'
                ? 'launch-accepted'
                : 'launch-response-unknown',
          },
        });
        expect(history.head.aggregateRevision).toBe(2);
        expect(
          await storage.resolveVerifiedLaunch({
            lease: value.lease,
            resolution,
          }),
        ).toBe('replay');
        await expect(
          storage.resolveVerifiedLaunch({
            lease: value.lease,
            resolution: {
              ...resolution,
              responseSha256: digest(`history-${kind}-changed`),
            },
          }),
        ).rejects.toBeInstanceOf(AuthorityConflict);
      }
    });

    it('keeps cancellation before response ordered and preserves cancelling phase', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await launchedCancellationEffect(storage, clock);
      const launch = await storage.claimLaunchWork({
        lease: value.lease,
        tenantId: cancellationTask.tenantId,
        attemptId: value.attemptId,
      });
      if (launch.work === undefined) throw new Error('missing launch work');
      const cancellation = new CancellationTaskEffectCoordinator(
        storage,
        clock,
      );
      const input = {
        lease: value.lease,
        tenantId: cancellationTask.tenantId,
        task: cancellationTask,
        sourceFactId: value.effect.sourceFactId,
        effectKey: value.effect.effectKey,
      };
      const cancelled = await cancellation.reconcile(input);
      expect(cancelled.attempt?.phase).toBe('cancelling');
      expect(cancelled.presentation).toBeUndefined();
      const response = await new LaunchResponseBoundary(
        {
          resolve: async () => ({
            kind: 'accepted' as const,
            responseSha256: digest('cancel-before-response'),
          }),
        },
        clock,
      ).resolve(launch.work);
      expect(
        await storage.resolveVerifiedLaunch({
          lease: value.lease,
          resolution: response,
        }),
      ).toBe('applied');
      expect(
        await storage.readAttempt({
          tenantId: cancellationTask.tenantId,
          attemptId: value.attemptId,
        }),
      ).toMatchObject({ phase: 'cancelling', launch: { state: 'accepted' } });
      const history = await readLaunchHistory(
        hooks,
        storage,
        value.lease,
        value.attemptId,
        cancellationTask.tenantId,
      );
      expect(
        history.records.command.map(
          (entry) =>
            (entry.payload as { payload?: { kind?: string } }).payload?.kind,
        ),
      ).toEqual(['attempt-registered', 'request-cancel', 'launch-accepted']);
    });

    it('rejects a forged response after direct cancel suppresses launch', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await launchedCancellationEffect(storage, clock);
      const cancellation = new CancellationTaskEffectCoordinator(
        storage,
        clock,
      );
      const input = {
        lease: value.lease,
        tenantId: cancellationTask.tenantId,
        task: cancellationTask,
        sourceFactId: value.effect.sourceFactId,
        effectKey: value.effect.effectKey,
      };
      const cancelled = await cancellation.reconcile(input);
      expect(cancelled.attempt?.phase).toBe('terminal');
      expect(
        await storage.readLaunch({
          tenantId: cancellationTask.tenantId,
          attemptId: value.attemptId,
        }),
      ).toMatchObject({ state: 'suppressed' });
      const beforeAttempt = await storage.readAttempt({
        tenantId: cancellationTask.tenantId,
        attemptId: value.attemptId,
      });
      const beforeHistory = await readLaunchHistory(
        hooks,
        storage,
        value.lease,
        value.attemptId,
        cancellationTask.tenantId,
      );
      expect(
        beforeHistory.records.command.map(
          (entry) =>
            (entry.payload as { payload?: { kind?: string } }).payload?.kind,
        ),
      ).toEqual(['attempt-registered', 'cancel-unlaunched']);
      expect(
        await storage.claimLaunchWork({
          lease: value.lease,
          tenantId: cancellationTask.tenantId,
          attemptId: value.attemptId,
        }),
      ).toEqual({ status: 'terminal' });
      await expect(
        storage.resolveVerifiedLaunch({
          lease: value.lease,
          resolution: {
            work: {},
            kind: 'accepted',
            responseSha256: digest('forged-suppressed-response'),
            resolvedAt: T0,
          } as never,
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      expect(
        await storage.readAttempt({
          tenantId: cancellationTask.tenantId,
          attemptId: value.attemptId,
        }),
      ).toEqual(beforeAttempt);
      expect(
        await readLaunchHistory(
          hooks,
          storage,
          value.lease,
          value.attemptId,
          cancellationTask.tenantId,
        ),
      ).toEqual(beforeHistory);
    });

    it('promotes cancellation work on later binding and replays after progress', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await launchedCancellationEffect(storage, clock);
      const launch = await storage.claimLaunchWork({
        lease: value.lease,
        tenantId: cancellationTask.tenantId,
        attemptId: value.attemptId,
      });
      if (launch.work === undefined) throw new Error('missing launch work');
      const cancellation = new CancellationTaskEffectCoordinator(
        storage,
        clock,
      );
      const input = {
        lease: value.lease,
        tenantId: cancellationTask.tenantId,
        task: cancellationTask,
        sourceFactId: value.effect.sourceFactId,
        effectKey: value.effect.effectKey,
      };
      await cancellation.reconcile(input);
      const response = await new LaunchResponseBoundary(
        {
          resolve: async () => ({
            kind: 'unknown' as const,
            responseSha256: digest('late-binding-history'),
          }),
        },
        clock,
      ).resolve(launch.work);
      expect(
        await storage.resolveVerifiedLaunch({
          lease: value.lease,
          resolution: response,
        }),
      ).toBe('applied');
      const accepted = await storage.readAttempt({
        tenantId: cancellationTask.tenantId,
        attemptId: value.attemptId,
      });
      if (accepted === undefined) throw new Error('missing accepted attempt');
      const bindingPayload = {
        kind: 'run-bound' as const,
        binding: {
          runId: 901,
          runAttempt: 1,
          checkRunId: 902,
          workflowPath: accepted.spec.execution.workflowPath,
          workflowRef: accepted.spec.execution.workflowRef,
          workflowSha: accepted.spec.execution.workflowSha,
        },
      };
      await ingestVerifiedRunBinding(
        storage,
        value.lease,
        await bindingVerifier.verify({
          localAttemptMarker: accepted.spec.local.attemptMarker,
          envelope: {
            schema: 'agent-lcars.runtime-observation/v1',
            version: 1,
            requestId: 'request-launch-history-binding',
            factId: 'fact-launch-history-binding',
            attemptId: accepted.spec.attemptId,
            tenant: accepted.spec.tenant,
            task: accepted.spec.task,
            source: { kind: 'github-provider', sourceId: 'history-provider' },
            observedAt: T0,
            payloadSha256:
              await runtimeObservationPayloadSha256(bindingPayload),
            payload: bindingPayload,
          },
        }),
      );
      expect(
        await storage.listCancellationWork({
          tenantId: cancellationTask.tenantId,
        }),
      ).toMatchObject([{ attemptId: value.attemptId, state: 'pending' }]);
      const beforeReplay = await readLaunchHistory(
        hooks,
        storage,
        value.lease,
        value.attemptId,
        cancellationTask.tenantId,
      );
      expect(
        await storage.resolveVerifiedLaunch({
          lease: value.lease,
          resolution: response,
        }),
      ).toBe('replay');
      const afterReplay = await readLaunchHistory(
        hooks,
        storage,
        value.lease,
        value.attemptId,
        cancellationTask.tenantId,
      );
      expect(afterReplay.head).toEqual(beforeReplay.head);
      expect(afterReplay.records.command).toHaveLength(
        beforeReplay.records.command.length,
      );
    });

    it('rejects corrupt private refs, records, heads, and missing history lineage', async () => {
      for (const corruption of [
        'response',
        'command-ref',
        'missing-history',
        'payload',
        'digest',
        'head',
        'admission-receipt',
        'task-pointer',
        'lineage',
      ] as const) {
        const clock = new Clock();
        const storage = await factory.create(clock);
        const value = await admitted(storage);
        const claim = await storage.claimLaunchWork({
          lease: value.lease,
          tenantId: tenant.tenantId,
          attemptId: value.spec.attemptId,
        });
        if (claim.work === undefined) throw new Error('missing launch work');
        const response = await new LaunchResponseBoundary(
          {
            resolve: async () => ({
              kind: 'accepted' as const,
              responseSha256: digest('corruption-response'),
            }),
          },
          clock,
        ).resolve(claim.work);
        await storage.resolveVerifiedLaunch({
          lease: value.lease,
          resolution: response,
        });
        if (corruption === 'lineage') {
          hooks.deleteAttemptHistory(storage);
        } else if (corruption === 'head') {
          hooks.corruptLaunchResolutionHistoryHead(storage);
        } else if (corruption === 'payload' || corruption === 'digest') {
          hooks.corruptLaunchResolutionHistoryRecord(storage, corruption);
        } else if (
          corruption === 'admission-receipt' ||
          corruption === 'task-pointer'
        ) {
          hooks.corruptLaunchResolutionAdmission(
            storage,
            corruption === 'admission-receipt' ? 'receipt' : 'task-pointer',
          );
        } else {
          hooks.corruptLaunchResolutionReceipt(storage, corruption);
        }
        await expect(
          storage.resolveVerifiedLaunch({
            lease: value.lease,
            resolution: response,
          }),
        ).rejects.toBeInstanceOf(AuthorityConflict);
      }
    });

    it('enforces claim token, permission, lease, and fence authority', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await admitted(storage);
      const claim = await storage.claimLaunchWork({
        lease: value.lease,
        tenantId: tenant.tenantId,
        attemptId: value.spec.attemptId,
      });
      if (claim.work === undefined) throw new Error('missing launch work');
      const response = await new LaunchResponseBoundary(
        {
          resolve: async () => ({
            kind: 'accepted' as const,
            responseSha256: digest('authority-response'),
          }),
        },
        clock,
      ).resolve(claim.work);
      await expect(
        storage.resolveVerifiedLaunch({
          lease: value.lease,
          resolution: {
            ...response,
            work: { ...response.work, claimToken: 'forged-token' },
          },
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      await expect(
        storage.resolveVerifiedLaunch({
          lease: value.lease,
          resolution: {
            ...response,
            work: { ...response.work, permission: 'reconcile-unknown' },
          },
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      clock.set(T1);
      const later = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'later-fence',
        leaseDurationMs: 60_000,
      });
      await expect(
        storage.resolveVerifiedLaunch({
          lease: value.lease,
          resolution: response,
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      const takeover = await storage.claimLaunchWork({
        lease: later,
        tenantId: tenant.tenantId,
        attemptId: value.spec.attemptId,
      });
      if (takeover.work === undefined) throw new Error('missing takeover work');
      await expect(
        storage.resolveVerifiedLaunch({
          lease: later,
          resolution: response,
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      const acceptedTakeover = await new LaunchResponseBoundary(
        {
          resolve: async () => ({
            kind: 'accepted' as const,
            responseSha256: digest('fenced-accepted'),
          }),
        },
        clock,
      ).resolve(takeover.work);
      await expect(
        storage.resolveVerifiedLaunch({
          lease: later,
          resolution: acceptedTakeover,
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      const unknown = await new LaunchResponseBoundary(
        {
          resolve: async () => ({
            kind: 'unknown' as const,
            responseSha256: digest('fenced-unknown'),
          }),
        },
        clock,
      ).resolve(takeover.work);
      await expect(
        storage.resolveVerifiedLaunch({ lease: later, resolution: unknown }),
      ).resolves.toBe('applied');
    });

    it('rolls back legacy, receipt, and history state when history commit fails', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await admitted(storage);
      const claim = await storage.claimLaunchWork({
        lease: value.lease,
        tenantId: tenant.tenantId,
        attemptId: value.spec.attemptId,
      });
      if (claim.work === undefined) throw new Error('missing launch work');
      const response = await new LaunchResponseBoundary(
        {
          resolve: async () => ({
            kind: 'accepted' as const,
            responseSha256: digest('rollback-response'),
          }),
        },
        clock,
      ).resolve(claim.work);
      const beforeAttempt = await storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: value.spec.attemptId,
      });
      const beforeLaunch = await storage.readLaunch({
        tenantId: tenant.tenantId,
        attemptId: value.spec.attemptId,
      });
      const beforeHistory = await readLaunchHistory(
        hooks,
        storage,
        value.lease,
        value.spec.attemptId,
      );
      const beforeInternals = hooks.inspectLaunchResolutionInternals(storage);
      const restore = hooks.failLaunchResolutionHistoryCommit(storage);
      await expect(
        storage.resolveVerifiedLaunch({
          lease: value.lease,
          resolution: response,
        }),
      ).rejects.toThrow();
      restore();
      expect(
        await storage.readAttempt({
          tenantId: tenant.tenantId,
          attemptId: value.spec.attemptId,
        }),
      ).toEqual(beforeAttempt);
      expect(
        await storage.readLaunch({
          tenantId: tenant.tenantId,
          attemptId: value.spec.attemptId,
        }),
      ).toEqual(beforeLaunch);
      expect(
        await readLaunchHistory(
          hooks,
          storage,
          value.lease,
          value.spec.attemptId,
        ),
      ).toEqual(beforeHistory);
      expect(hooks.inspectLaunchResolutionInternals(storage)).toEqual(
        beforeInternals,
      );
      await expect(
        storage.resolveVerifiedLaunch({
          lease: value.lease,
          resolution: response,
        }),
      ).resolves.toBe('applied');
    });

    it('keeps pre-history adapters compatible and does not create shadow history', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await admitted(storage);
      hooks.deleteAdmissionLineage(storage);
      const claim = await storage.claimLaunchWork({
        lease: value.lease,
        tenantId: tenant.tenantId,
        attemptId: value.spec.attemptId,
      });
      if (claim.work === undefined) throw new Error('missing launch work');
      const response = await new LaunchResponseBoundary(
        {
          resolve: async () => ({
            kind: 'accepted' as const,
            responseSha256: digest('legacy-response'),
          }),
        },
        clock,
      ).resolve(claim.work);
      await expect(
        storage.resolveVerifiedLaunch({
          lease: value.lease,
          resolution: response,
        }),
      ).resolves.toBe('applied');
      await expect(
        storage.resolveVerifiedLaunch({
          lease: value.lease,
          resolution: response,
        }),
      ).resolves.toBe('replay');
      await expect(
        hooks.readAttemptHistory(storage, {
          lease: value.lease,
          tenantId: tenant.tenantId,
          attemptId: value.spec.attemptId,
        }),
      ).resolves.toBeUndefined();
    });
  });
}
