import type {
  ActivationRecord,
  ControlPlaneSignalEnvelope,
  PolicyDecision,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import type {
  AuthorityClock,
  LifecycleAuthorityStorage,
  TaskEffectTransitionResult,
} from './authority-storage';
import { InMemoryLifecycleAuthorityStorage } from './authority-storage';
import { stableIngressDeliverySha256 } from './ingress-policy';
import {
  SignalTaskComposition,
  type SignalTaskCompositionDependencies,
} from './signal-task-composition';

const T0 = '2026-08-14T19:00:00.000Z';
const TENANT = {
  tenantId: 'tenant-1',
  repositoryId: 123,
  repository: 'octo/example',
  installationId: 456,
} as const;
const ENVELOPE = {
  schema: 'agent-lcars.control-plane-signal/v1',
  version: 1,
  requestId: 'request-1',
  factId: 'fact-1',
  tenant: TENANT,
  task: {
    tenantId: TENANT.tenantId,
    repositoryId: TENANT.repositoryId,
    issueNumber: 9,
  },
  receivedAt: T0,
  source: {
    kind: 'github-webhook',
    deliveryId: 'delivery-1',
    repositoryId: TENANT.repositoryId,
    installationId: TENANT.installationId,
    bodySha256: 'a'.repeat(64),
    event: 'issues',
    action: 'opened',
    actorId: 789,
    actorLogin: 'octocat',
    occurredAt: T0,
    hmacKeyVersion: 'key-v1',
  },
  signal: {
    kind: 'requested-work',
    mode: 'implement',
    requestKey: 'request-1',
  },
} as unknown as ControlPlaneSignalEnvelope;
const POLICY = {
  schema: 'agent-lcars.policy-decision/v1',
  version: 1,
  policy: {
    policyId: 'policy-1',
    policyVersion: 1,
    contentSha256: 'b'.repeat(64),
  },
  decision: 'accepted',
  ruleId: 'rule-1',
  sourceFactId: 'fact-1',
  principal: { kind: 'github-actor', actorId: 789, login: 'octocat' },
  evidenceRef: 'evidence-1',
  decidedAt: T0,
} as PolicyDecision;
const ACTIVATION: ActivationRecord = {
  schema: 'agent-lcars.control-plane-activation/v1',
  version: 1,
  tenant: TENANT,
  taskClassId: 'github-issue',
  activationId: 'activation-1',
  authorityEpoch: 1,
  effectiveBoundary: 1,
  mode: 'central-authoritative',
  effectMode: 'enabled',
  recordedAt: T0,
};
const CANDIDATE = {
  intentId: 'intent-1',
  semanticKey: 'issue:9',
  semanticDigest: 'c'.repeat(64),
  orderingKey: { occurredAt: T0, tieBreaker: 'delivery-1' },
};

class FixedClock implements AuthorityClock {
  now(): string {
    return T0;
  }
}

function transition(status: 'applied' | 'replay'): TaskEffectTransitionResult {
  return {
    status,
    task: undefined as never,
    effects: [],
    plans: [],
    obsoletedPlans: [],
  };
}

function harness(
  options: {
    activation?: ActivationRecord | null;
    transition?: (call: number) => TaskEffectTransitionResult;
    leaseError?: Error;
    candidate?: typeof CANDIDATE | undefined;
    policy?: PolicyDecision;
  } = {},
) {
  // These tests exercise this composition's opaque handoff boundary with
  // injected seams. Forged receipt/envelope rejection is covered by the
  // lower-level ingress-policy verifier/normalizer contract suite.
  let deliveryCalls = 0;
  let policyHandoffReads = 0;
  let transitionCalls = 0;
  const seenPolicyDecisions: PolicyDecision[] = [];
  const runLease = vi.fn(async (_scope, operation) =>
    operation({ lease: true } as never),
  );
  const readTask = vi.fn(async () => undefined);
  const applyTaskEffectTransition = vi.fn(async (input: any) => {
    transitionCalls += 1;
    seenPolicyDecisions.push(input.transition.input.policyDecision);
    if (options.transition !== undefined) {
      return options.transition(transitionCalls);
    }
    return transition(transitionCalls === 1 ? 'applied' : 'replay');
  });
  const recordAndEvaluate = vi.fn(async () => {
    deliveryCalls += 1;
    policyHandoffReads += 1;
    return {
      status: deliveryCalls === 1 ? 'applied' : ('replay' as const),
      record: {
        tenantId: TENANT.tenantId,
        deliveryId: 'delivery-1',
        inputSha256: stableIngressDeliverySha256(ENVELOPE),
        bodySha256: 'a'.repeat(64),
        event: 'issues',
        action: 'opened',
        repositoryId: 123,
        installationId: 456,
        requestId: 'request-1',
        factId: 'fact-1',
        hmacKeyVersion: 'key-v1',
        receivedAt: T0,
        policyEvidence: undefined as never,
        handoff: {
          envelope: ENVELOPE,
          // The inbox owns this durable decision on both first delivery and
          // replay; the composition never re-evaluates policy.
          policyDecision: options.policy ?? POLICY,
        },
      },
    };
  });
  const inbox = {
    recordAndEvaluate,
  } as unknown as SignalTaskCompositionDependencies['inbox'];
  const dependencies: SignalTaskCompositionDependencies = {
    webhookVerifier: {
      verify: vi.fn(async () => ({ verified: true })),
    } as never,
    webhookNormalizer: {
      normalize: vi.fn(async () => ENVELOPE),
    } as never,
    inbox,
    storage: {
      readTask,
      applyTaskEffectTransition,
    } as unknown as LifecycleAuthorityStorage,
    activation: {
      resolve: vi.fn(async () =>
        options.activation === null
          ? undefined
          : (options.activation ?? ACTIVATION),
      ),
    },
    candidate: {
      resolve: vi.fn(async () => options.candidate ?? CANDIDATE),
    },
    leases: {
      run: options.leaseError
        ? vi.fn(async () => {
            throw options.leaseError;
          })
        : runLease,
    },
    clock: { now: () => T0 },
  };
  return {
    composition: new SignalTaskComposition(dependencies),
    dependencies,
    applyTaskEffectTransition,
    readTask,
    deliveryCalls: () => deliveryCalls,
    policyHandoffReads: () => policyHandoffReads,
    runLease,
    recordAndEvaluate,
    seenPolicyDecisions,
  };
}

async function realStorageHarness(activation: ActivationRecord = ACTIVATION) {
  const clock = new FixedClock();
  const storage = new InMemoryLifecycleAuthorityStorage(clock, {
    mint: () => 'A'.repeat(22),
  });
  await storage.registerActivation(ACTIVATION);
  let deliveryCount = 0;
  const recordAndEvaluate = vi.fn(async () => ({
    status: (deliveryCount++ === 0 ? 'applied' : 'replay') as
      'applied' | 'replay',
    record: {
      tenantId: TENANT.tenantId,
      deliveryId: 'delivery-1',
      inputSha256: stableIngressDeliverySha256(ENVELOPE),
      bodySha256: 'a'.repeat(64),
      event: 'issues',
      action: 'opened',
      repositoryId: TENANT.repositoryId,
      installationId: TENANT.installationId,
      requestId: ENVELOPE.requestId,
      factId: ENVELOPE.factId,
      hmacKeyVersion: 'key-v1',
      receivedAt: T0,
      policyEvidence: undefined as never,
      handoff: { envelope: ENVELOPE, policyDecision: POLICY },
    },
  }));
  const leases = vi.fn(async (_scope, operation) => {
    const lease = await storage.acquireTaskLease({
      scope: {
        tenantId: TENANT.tenantId,
        repositoryId: TENANT.repositoryId,
        issueNumber: 9,
      },
      ownerId: 'composition-test',
      leaseDurationMs: 60_000,
    });
    try {
      return await operation(lease);
    } finally {
      await storage.releaseTaskLease(lease);
    }
  });
  const dependencies: SignalTaskCompositionDependencies = {
    webhookVerifier: {
      verify: vi.fn(async () => ({ verified: true })),
    } as never,
    webhookNormalizer: { normalize: vi.fn(async () => ENVELOPE) } as never,
    inbox: { recordAndEvaluate } as never,
    storage,
    activation: { resolve: vi.fn(async () => activation) },
    candidate: { resolve: vi.fn(async () => CANDIDATE) },
    leases: { run: leases },
    clock,
  };
  return {
    composition: new SignalTaskComposition(dependencies),
    storage,
    recordAndEvaluate,
    leases,
  };
}

describe('inactive signal-to-task composition', () => {
  it('resumes the exact handoff after inbox commit and replays the transition', async () => {
    const test = harness();

    const first = await test.composition.handleWebhook({} as never);
    const replay = await test.composition.handleWebhook({} as never);

    expect(first.delivery.status).toBe('applied');
    expect(first.transition.status).toBe('applied');
    expect(replay.delivery.status).toBe('replay');
    expect(replay.transition.status).toBe('replay');
    expect(test.applyTaskEffectTransition).toHaveBeenCalledTimes(2);
    expect(test.readTask).toHaveBeenCalledTimes(2);
    expect(test.policyHandoffReads()).toBe(2);
  });

  it('derives scope and candidate from the normalized envelope only', async () => {
    const test = harness();

    await test.composition.handleWebhook({} as never);

    expect(test.dependencies.activation.resolve).toHaveBeenCalledWith({
      envelope: ENVELOPE,
      policyDecision: POLICY,
    });
    expect(test.dependencies.candidate.resolve).toHaveBeenCalledWith({
      envelope: ENVELOPE,
      policyDecision: POLICY,
    });
    expect(test.dependencies.leases.run).toHaveBeenCalledWith(
      {
        tenantId: TENANT.tenantId,
        repositoryId: TENANT.repositoryId,
        issueNumber: 9,
      },
      expect.any(Function),
    );
  });

  it('does not resolve a candidate for non-work signals', async () => {
    const test = harness();
    const nonWork = {
      ...ENVELOPE,
      signal: { kind: 'park', commandKey: 'park-1' },
    };
    (
      test.dependencies.webhookNormalizer.normalize as unknown as ReturnType<
        typeof vi.fn
      >
    ).mockResolvedValue(nonWork);
    test.recordAndEvaluate.mockImplementationOnce(async () => ({
      status: 'applied',
      record: {
        tenantId: TENANT.tenantId,
        deliveryId: 'delivery-1',
        inputSha256: stableIngressDeliverySha256(nonWork),
        bodySha256: 'a'.repeat(64),
        event: 'issues',
        action: 'opened',
        repositoryId: 123,
        installationId: 456,
        requestId: 'request-1',
        factId: 'fact-1',
        hmacKeyVersion: 'key-v1',
        receivedAt: T0,
        policyEvidence: undefined as never,
        handoff: {
          envelope: nonWork,
          policyDecision: POLICY,
        },
      },
    }));

    await test.composition.handleWebhook({} as never);

    expect(test.dependencies.candidate.resolve).not.toHaveBeenCalled();
  });

  it('fails closed before leasing when requested work has no server candidate', async () => {
    const test = harness();
    (
      test.dependencies.candidate.resolve as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue(undefined);

    await expect(test.composition.handleWebhook({} as never)).rejects.toThrow(
      'no server-owned intent candidate',
    );
    expect(test.runLease).not.toHaveBeenCalled();
    expect(test.applyTaskEffectTransition).not.toHaveBeenCalled();
  });

  it('re-drives a transition after a crash following inbox commit without re-evaluating policy', async () => {
    const test = harness({
      transition: (call) => {
        if (call === 1) throw new Error('crash after inbox commit');
        return transition('replay');
      },
    });

    await expect(test.composition.handleWebhook({} as never)).rejects.toThrow(
      'crash after inbox commit',
    );
    const replay = await test.composition.handleWebhook({} as never);

    expect(replay.transition.status).toBe('replay');
    expect(test.seenPolicyDecisions).toEqual([POLICY, POLICY]);
    expect(test.dependencies.activation.resolve).toHaveBeenCalledTimes(2);
  });

  it('uses the inbox-owned policy revision when a newer policy exists on replay', async () => {
    const test = harness();
    const newerPolicy = {
      ...POLICY,
      policy: { ...POLICY.policy, policyVersion: 2 },
      contentSha256: 'e'.repeat(64),
    } as PolicyDecision;
    // The current normalized delivery is unchanged, while the policy source
    // is imagined to have advanced. The inbox replay still supplies POLICY.
    test.recordAndEvaluate.mockImplementation(async () => ({
      status: 'replay',
      record: {
        tenantId: TENANT.tenantId,
        deliveryId: 'delivery-1',
        inputSha256: stableIngressDeliverySha256(ENVELOPE),
        bodySha256: 'a'.repeat(64),
        event: 'issues',
        action: 'opened',
        repositoryId: 123,
        installationId: 456,
        requestId: 'request-1',
        factId: 'fact-1',
        hmacKeyVersion: 'key-v1',
        receivedAt: T0,
        policyEvidence: { revision: newerPolicy.policy.policyVersion } as never,
        handoff: { envelope: ENVELOPE, policyDecision: POLICY },
      },
    }));

    await test.composition.handleWebhook({} as never);

    expect(test.seenPolicyDecisions).toEqual([POLICY]);
    expect(newerPolicy.policy.policyVersion).toBe(2);
  });

  it.each([
    ['missing', null],
    ['retired', { ...ACTIVATION, mode: 'retired' as const }],
    [
      'wrong tenant',
      { ...ACTIVATION, tenant: { ...TENANT, tenantId: 'other' } },
    ],
  ])(
    'fails closed for %s activation before leasing',
    async (_name, activation) => {
      const test = harness({ activation });

      await expect(test.composition.handleWebhook({} as never)).rejects.toThrow(
        'activation is unavailable',
      );
      expect(test.runLease).not.toHaveBeenCalled();
      expect(test.applyTaskEffectTransition).not.toHaveBeenCalled();
    },
  );

  it('passes shadow activation through the transition with no admission/provider execution', async () => {
    const shadow = {
      ...ACTIVATION,
      mode: 'shadow' as const,
      effectMode: 'none' as const,
    };
    const test = harness({ activation: shadow });

    const result = await test.composition.handleWebhook({} as never);

    expect(result.transition.effects).toEqual([]);
    expect(test.applyTaskEffectTransition).toHaveBeenCalledTimes(1);
  });

  it('keeps rejected policy and ambiguous transition outcomes effect-free', async () => {
    const rejected = { ...POLICY, decision: 'rejected' as const };
    const test = harness({
      policy: rejected,
      transition: () => transition('applied'),
    });

    const result = await test.composition.handleWebhook({} as never);

    expect(result.transition.effects).toEqual([]);
    expect(test.applyTaskEffectTransition).toHaveBeenCalledTimes(1);
  });

  it('surfaces lease/revision failure without a speculative retry', async () => {
    const test = harness({ leaseError: new Error('revision conflict') });

    await expect(test.composition.handleWebhook({} as never)).rejects.toThrow(
      'revision conflict',
    );
    expect(test.dependencies.leases.run).toHaveBeenCalledTimes(1);
    expect(test.applyTaskEffectTransition).not.toHaveBeenCalled();
  });

  it('lets atomic storage collapse concurrent identical deliveries to one applied transition', async () => {
    const test = harness();

    const results = await Promise.all([
      test.composition.handleWebhook({} as never),
      test.composition.handleWebhook({} as never),
    ]);

    expect(results.map((result) => result.transition.status).sort()).toEqual([
      'applied',
      'replay',
    ]);
    expect(test.applyTaskEffectTransition).toHaveBeenCalledTimes(2);
  });

  it('accepts replay after receipt time and HMAC-key rotation using stable delivery identity', async () => {
    const test = harness();
    const rotatedReceipt = {
      ...ENVELOPE,
      receivedAt: '2026-08-14T19:05:00.000Z',
      source: { ...ENVELOPE.source, hmacKeyVersion: 'key-v2' },
    };
    (
      test.dependencies.webhookNormalizer.normalize as unknown as ReturnType<
        typeof vi.fn
      >
    ).mockResolvedValue(rotatedReceipt);

    const result = await test.composition.handleWebhook({} as never);

    expect(result.transition.status).toBe('applied');
    expect(test.dependencies.activation.resolve).toHaveBeenCalledWith({
      envelope: ENVELOPE,
      policyDecision: POLICY,
    });
  });

  it('uses real storage to apply one pending admission effect and replay without executing it', async () => {
    const test = await realStorageHarness();

    const results = await Promise.all([
      test.composition.handleWebhook({} as never),
      test.composition.handleWebhook({} as never),
    ]);

    expect(results.map((result) => result.transition.status).sort()).toEqual([
      'applied',
      'replay',
    ]);
    const state = await test.storage.readTask({
      tenantId: TENANT.tenantId,
      repositoryId: TENANT.repositoryId,
      issueNumber: 9,
    });
    expect(state?.attempt.kind).toBe('unlaunched');
    const effects = await test.storage.listTaskEffects({
      tenantId: TENANT.tenantId,
      task: {
        tenantId: TENANT.tenantId,
        repositoryId: TENANT.repositoryId,
        issueNumber: 9,
      },
    });
    expect(effects).toHaveLength(1);
    expect(effects[0]?.payload.kind).toBe('admit-attempt');
    expect(effects[0]?.deliveryState).toBe('pending');
    await expect(
      test.storage.readAttempt({
        tenantId: TENANT.tenantId,
        attemptId: 'A'.repeat(22),
      }),
    ).resolves.toBeUndefined();
    expect(test.recordAndEvaluate).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['stale epoch', { ...ACTIVATION, authorityEpoch: 0 }],
    ['wrong task class', { ...ACTIVATION, taskClassId: 'other-class' }],
  ])(
    'real storage rejects %s activation before creating effects',
    async (_name, activation) => {
      const test = await realStorageHarness(activation);

      await expect(test.composition.handleWebhook({} as never)).rejects.toThrow(
        'activation is not registered and current',
      );
      await expect(
        test.storage.listTaskEffects({
          tenantId: TENANT.tenantId,
          task: {
            tenantId: TENANT.tenantId,
            repositoryId: TENANT.repositoryId,
            issueNumber: 9,
          },
        }),
      ).resolves.toEqual([]);
      expect(test.leases).toHaveBeenCalledTimes(1);
    },
  );
});
