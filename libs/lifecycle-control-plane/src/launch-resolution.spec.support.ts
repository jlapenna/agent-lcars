import { createHash } from 'node:crypto';

import type {
  AcceptedAttemptSpec,
  ActivationRecord,
} from '@agent-lcars/dispatch-contracts';
import { runtimeObservationPayloadSha256 } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import type {
  AuthorityClock,
  LifecycleAuthorityStorage,
} from './authority-storage';
import { AuthorityConflict } from './authority-storage';
import { admitAcceptedSpecForTest } from './authority-storage-test-support';
import {
  ingestVerifiedRunBinding,
  RunBindingIngressVerifier,
} from './launch-binding';
import { LaunchResolutionCoordinator } from './launch-resolution';
import { LaunchResponseBoundary } from './launch-resolution-capability';
import { writeAttemptForTest } from './launch-resolution-test-support';

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
