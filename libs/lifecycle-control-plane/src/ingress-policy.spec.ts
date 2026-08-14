import { createHmac } from 'node:crypto';

import type { PolicyDecision } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import type { AuthorityClock } from './authority-storage';
import {
  GitHubWebhookNormalizer,
  GitHubWebhookVerifier,
  IngressPolicyConflict,
  ingressPolicyContentSha256,
  type IngressPolicyInbox,
  InMemoryIngressPolicyInbox,
  InMemoryTenantRegistrationRegistry,
  NodeWebhookHmacSha256,
  type PolicyEvidenceResolver,
  prepareReducerIngressHandoff,
  type RegisteredIngressPolicy,
  type VerifiedGitHubWebhookReceipt,
  type WebhookVerificationKey,
} from './ingress-policy';

const T0 = '2026-08-16T00:00:00.000Z';
const T1 = '2026-08-16T01:00:00.000Z';
const SECRET_ONE = Buffer.from('key-one');
const SECRET_TWO = Buffer.from('key-two');

export interface IngressPolicyContractClock extends AuthorityClock {
  set(value: string): void;
}

class ManualClock implements IngressPolicyContractClock {
  constructor(private value = T0) {}
  now(): string {
    return this.value;
  }
  set(value: string): void {
    this.value = value;
  }
}

class MutableKeyResolver {
  constructor(public keys: readonly WebhookVerificationKey[]) {}
  async resolveKeys(): Promise<readonly WebhookVerificationKey[]> {
    return this.keys;
  }
}

class MutableEvidenceResolver implements PolicyEvidenceResolver {
  calls = 0;

  constructor(public current = evidence()) {}

  async resolve() {
    this.calls += 1;
    return structuredClone(this.current);
  }
}

function payload(
  options: {
    repositoryId?: number;
    installationId?: number;
    repository?: string;
    actorId?: number;
    actorLogin?: string;
    action?: string;
    issueNumber?: number;
    occurredAt?: string;
  } = {},
): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      action: options.action ?? 'labeled',
      repository: {
        id: options.repositoryId ?? 123,
        full_name: options.repository ?? 'renamed/example',
      },
      installation: { id: options.installationId ?? 456 },
      sender: {
        id: options.actorId ?? 789,
        login: options.actorLogin ?? 'octocat-renamed',
      },
      issue: {
        number: options.issueNumber ?? 9,
        updated_at: options.occurredAt ?? T0,
      },
    }),
  );
}

function signature(secret: Uint8Array, rawBody: Uint8Array): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

function policy(
  input: {
    version?: number;
    tenantId?: string;
    repositoryId?: number;
    decision?: 'accepted' | 'rejected';
    actorIds?: readonly number[];
    priority?: number;
    roles?: readonly string[];
    ruleId?: string;
    modes?: readonly ('implement' | 'review' | 'reply' | 'runbook')[];
  } = {},
): RegisteredIngressPolicy {
  const base: Omit<RegisteredIngressPolicy, 'contentSha256'> = {
    schema: 'agent-lcars.registered-ingress-policy/v1',
    version: 1,
    tenantId: input.tenantId ?? 'tenant-1',
    repositoryId: input.repositoryId ?? 123,
    policyId: 'policy-1',
    policyVersion: input.version ?? 1,
    rules: [
      {
        ruleId: input.ruleId ?? 'maintainer-implement',
        priority: input.priority ?? 10,
        decision: input.decision ?? 'accepted',
        principal: {
          kind: 'github-actor',
          actorIds: input.actorIds ?? [789],
        },
        requiredRoles: input.roles ?? ['maintainer'],
        sourceKinds: ['github-webhook'],
        signalKinds: ['requested-work'],
        modes: input.modes ?? ['implement'],
      },
    ],
  };
  return { ...base, contentSha256: ingressPolicyContentSha256(base) };
}

function evidence(actorId = 789, roles = ['maintainer']) {
  return {
    principal: {
      kind: 'github-actor' as const,
      actorId,
      /** Mutable login intentionally differs from the webhook display value. */
      login: 'old-login',
    },
    roles,
    evidenceRef: `role-proof-${actorId}`,
  };
}

async function environment(
  options: {
    tenantId?: string;
    repositoryId?: number;
    installationId?: number;
    secret?: Uint8Array;
    keyVersion?: string;
    clock?: ManualClock;
  } = {},
) {
  const clock = options.clock ?? new ManualClock();
  const repositoryId = options.repositoryId ?? 123;
  const installationId = options.installationId ?? 456;
  const tenantId = options.tenantId ?? 'tenant-1';
  const keys = new MutableKeyResolver([
    {
      version: options.keyVersion ?? 'key-v1',
      secret: options.secret ?? SECRET_ONE,
    },
  ]);
  const verifier = new GitHubWebhookVerifier(
    keys,
    new NodeWebhookHmacSha256(),
    clock,
  );
  const tenants = new InMemoryTenantRegistrationRegistry();
  await tenants.register({
    tenant: {
      tenantId,
      repositoryId,
      repository: `canonical/repo-${repositoryId}`,
      installationId,
    },
  });
  const normalizer = new GitHubWebhookNormalizer(tenants, {
    interpret: async (fact) => ({
      kind: 'requested-work',
      mode: 'implement',
      requestKey: fact.requestId,
    }),
  });
  const makeEnvelope = async (
    input: {
      rawBody?: Uint8Array;
      deliveryId?: string;
      event?: string;
      secret?: Uint8Array;
    } = {},
  ) => {
    const rawBody = input.rawBody ?? payload({ repositoryId, installationId });
    const receipt = await verifier.verify({
      rawBody,
      signatureHeader: signature(
        input.secret ?? options.secret ?? SECRET_ONE,
        rawBody,
      ),
      deliveryId: input.deliveryId ?? 'delivery-1',
      event: input.event ?? 'issues',
    });
    return { receipt, envelope: await normalizer.normalize(receipt) };
  };
  return { clock, keys, verifier, tenants, normalizer, makeEnvelope };
}

describe('inactive GitHub ingress verification and normalization', () => {
  it('verifies exact raw bytes and selects the matching rotated key internally', async () => {
    const clock = new ManualClock();
    const keys = new MutableKeyResolver([
      { version: 'key-v2', secret: SECRET_TWO },
      { version: 'key-v1', secret: SECRET_ONE },
    ]);
    const verifier = new GitHubWebhookVerifier(
      keys,
      new NodeWebhookHmacSha256(),
      clock,
    );
    const rawBody = payload();
    const receipt = await verifier.verify({
      rawBody,
      signatureHeader: signature(SECRET_ONE, rawBody),
      deliveryId: 'delivery-1',
      event: 'issues',
    });
    expect(receipt).toMatchObject({
      deliveryId: 'delivery-1',
      hmacKeyVersion: 'key-v1',
      receivedAt: T0,
    });
    expect(JSON.stringify(receipt)).not.toMatch(
      /rawBody|signature|secret|key-one|key-two/iu,
    );

    const reserialized = Buffer.from(`${Buffer.from(rawBody).toString()} `);
    await expect(
      verifier.verify({
        rawBody: reserialized,
        signatureHeader: signature(SECRET_ONE, rawBody),
        deliveryId: 'delivery-2',
        event: 'issues',
      }),
    ).rejects.toThrow(IngressPolicyConflict);
  });

  it('rejects malformed, no-match, and ambiguous multi-key signatures', async () => {
    const rawBody = payload();
    const clock = new ManualClock();
    const keys = new MutableKeyResolver([
      { version: 'key-v1', secret: SECRET_ONE },
    ]);
    const verifier = new GitHubWebhookVerifier(
      keys,
      new NodeWebhookHmacSha256(),
      clock,
    );
    for (const signatureHeader of [
      '',
      'sha256=bad',
      `${signature(SECRET_ONE, rawBody)},${signature(SECRET_ONE, rawBody)}`,
      signature(SECRET_TWO, rawBody),
    ]) {
      await expect(
        verifier.verify({
          rawBody,
          signatureHeader,
          deliveryId: 'delivery-1',
          event: 'issues',
        }),
      ).rejects.toThrow(IngressPolicyConflict);
    }
    keys.keys = [
      { version: 'key-v1', secret: SECRET_ONE },
      { version: 'key-v2', secret: SECRET_ONE },
    ];
    await expect(
      verifier.verify({
        rawBody,
        signatureHeader: signature(SECRET_ONE, rawBody),
        deliveryId: 'delivery-1',
        event: 'issues',
      }),
    ).rejects.toThrow(IngressPolicyConflict);
  });

  it('selects tenants only by numeric repository and installation', async () => {
    const env = await environment();
    const renamed = await env.makeEnvelope({
      rawBody: payload({ repository: 'totally/renamed' }),
    });
    expect(renamed.envelope.tenant.repository).toBe('canonical/repo-123');
    expect(renamed.envelope.task).toEqual({
      tenantId: 'tenant-1',
      repositoryId: 123,
      issueNumber: 9,
    });
    await expect(
      env.makeEnvelope({ rawBody: payload({ installationId: 999 }) }),
    ).rejects.toThrow(IngressPolicyConflict);
    await expect(
      env.tenants.register({
        tenant: {
          tenantId: 'tenant-1',
          repositoryId: 999,
          repository: 'other/repo',
          installationId: 1000,
        },
      }),
    ).rejects.toThrow(IngressPolicyConflict);
  });

  it('derives stable identities and rejects forged or malformed receipts', async () => {
    const env = await environment();
    const first = await env.makeEnvelope();
    const replay = await env.normalizer.normalize(first.receipt);
    expect(replay.requestId).toBe(first.envelope.requestId);
    expect(replay.factId).toBe(first.envelope.factId);
    const second = await env.makeEnvelope({ deliveryId: 'delivery-2' });
    expect(second.envelope.requestId).not.toBe(first.envelope.requestId);
    expect(second.envelope.factId).not.toBe(first.envelope.factId);
    await expect(
      env.normalizer.normalize({
        ...first.receipt,
        deliveryId: 'forged-delivery',
      } as VerifiedGitHubWebhookReceipt),
    ).rejects.toThrow(IngressPolicyConflict);

    const bad = Buffer.from('{not-json');
    const receipt = await env.verifier.verify({
      rawBody: bad,
      signatureHeader: signature(SECRET_ONE, bad),
      deliveryId: 'delivery-bad',
      event: 'issues',
    });
    await expect(env.normalizer.normalize(receipt)).rejects.toThrow(
      IngressPolicyConflict,
    );
  });
});

describe('registered ingress policy evaluation', () => {
  it('authorizes by numeric actor, role, source, signal, and mode—not login', async () => {
    const env = await environment();
    const { envelope } = await env.makeEnvelope();
    const resolver = new MutableEvidenceResolver();
    const inbox = new InMemoryIngressPolicyInbox(env.clock, resolver);
    const registered = policy();
    await inbox.registerPolicy(registered);
    const result = await inbox.recordAndEvaluate({ envelope });
    expect(result.record.handoff.policyDecision).toMatchObject({
      decision: 'accepted',
      ruleId: 'maintainer-implement',
      sourceFactId: envelope.factId,
      principal: {
        kind: 'github-actor',
        actorId: 789,
        login: 'octocat-renamed',
      },
      policy: { policyVersion: 1, contentSha256: registered.contentSha256 },
    });
  });

  it('denies no-match, wrong role/mode, explicit rejection, and top-priority ties', async () => {
    const env = await environment();
    const { envelope } = await env.makeEnvelope();
    const decide = async (
      registered: RegisteredIngressPolicy,
      roleEvidence = evidence(),
    ): Promise<PolicyDecision> => {
      const resolver = new MutableEvidenceResolver(roleEvidence);
      const inbox = new InMemoryIngressPolicyInbox(env.clock, resolver);
      await inbox.registerPolicy(registered);
      return (await inbox.recordAndEvaluate({ envelope })).record.handoff
        .policyDecision;
    };
    expect(await decide(policy(), evidence(789, []))).toMatchObject({
      decision: 'rejected',
      ruleId: 'deny-by-default',
    });
    expect(await decide(policy({ modes: ['review'] }))).toMatchObject({
      decision: 'rejected',
    });
    expect(await decide(policy({ decision: 'rejected' }))).toMatchObject({
      decision: 'rejected',
      ruleId: 'maintainer-implement',
    });

    const one = policy();
    const tieBase: Omit<RegisteredIngressPolicy, 'contentSha256'> = {
      ...one,
      rules: [
        ...one.rules,
        { ...one.rules[0]!, ruleId: 'same-priority-second' },
      ],
    };
    const tie = {
      ...tieBase,
      contentSha256: ingressPolicyContentSha256(tieBase),
    };
    expect(await decide(tie)).toMatchObject({
      decision: 'rejected',
      ruleId: 'ambiguous-policy',
    });
  });

  it('rejects wrong principal evidence and invalid policy content provenance', async () => {
    const env = await environment();
    const { envelope } = await env.makeEnvelope();
    const resolver = new MutableEvidenceResolver(evidence(999));
    const inbox = new InMemoryIngressPolicyInbox(env.clock, resolver);
    await inbox.registerPolicy(policy());
    await expect(inbox.recordAndEvaluate({ envelope })).rejects.toThrow(
      IngressPolicyConflict,
    );
    await expect(
      inbox.registerPolicy({ ...policy(), contentSha256: 'a'.repeat(64) }),
    ).rejects.toThrow(IngressPolicyConflict);
  });
});

export function runIngressPolicyInboxContract(
  makeInbox: (
    clock: IngressPolicyContractClock,
    evidenceResolver: PolicyEvidenceResolver,
  ) => IngressPolicyInbox | Promise<IngressPolicyInbox>,
): void {
  const makeHarness = async () => {
    const clock = new ManualClock();
    const env = await environment({ clock });
    const evidenceResolver = new MutableEvidenceResolver();
    return {
      clock,
      env,
      evidenceResolver,
      inbox: await makeInbox(clock, evidenceResolver),
    };
  };

  describe('Ingress policy inbox backend contract', () => {
    it('atomically applies one concurrent delivery and replays the original decision', async () => {
      const { inbox, env } = await makeHarness();
      await inbox.registerPolicy(policy());
      const { envelope } = await env.makeEnvelope();
      const inputs = [
        inbox.recordAndEvaluate({ envelope }),
        inbox.recordAndEvaluate({ envelope }),
      ];
      const results = await Promise.all(inputs);
      expect(results.map((result) => result.status).sort()).toEqual([
        'applied',
        'replay',
      ]);
      expect(results[0]?.record.handoff).toEqual(results[1]?.record.handoff);
    });

    it('returns a stored decision before consulting a newer policy', async () => {
      const { inbox, env, clock } = await makeHarness();
      const firstPolicy = policy();
      await inbox.registerPolicy(firstPolicy);
      const { envelope } = await env.makeEnvelope();
      const first = await inbox.recordAndEvaluate({ envelope });
      clock.set(T1);
      await inbox.registerPolicy(policy({ version: 2, decision: 'rejected' }));
      const replay = await inbox.recordAndEvaluate({ envelope });
      expect(replay.status).toBe('replay');
      expect(replay.record.handoff.policyDecision).toEqual(
        first.record.handoff.policyDecision,
      );
      expect(replay.record.handoff.policyDecision.policy.policyVersion).toBe(1);
    });

    it('replays a redelivery verified later under a rotated key', async () => {
      const { inbox, env, clock, evidenceResolver } = await makeHarness();
      await inbox.registerPolicy(policy());
      const rawBody = payload();
      const first = await env.makeEnvelope({ rawBody });
      const applied = await inbox.recordAndEvaluate({
        envelope: first.envelope,
      });
      clock.set(T1);
      env.keys.keys = [{ version: 'key-v2', secret: SECRET_TWO }];
      const redelivery = await env.makeEnvelope({
        rawBody,
        secret: SECRET_TWO,
      });
      expect(redelivery.envelope.receivedAt).toBe(T1);
      expect(redelivery.envelope.source).toMatchObject({
        kind: 'github-webhook',
        hmacKeyVersion: 'key-v2',
      });
      const replay = await inbox.recordAndEvaluate({
        envelope: redelivery.envelope,
      });
      expect(replay.status).toBe('replay');
      expect(replay.record).toEqual(applied.record);
      expect(evidenceResolver.calls).toBe(1);
    });

    it('conflicts changed delivery material without partial replacement', async () => {
      const { inbox, env } = await makeHarness();
      await inbox.registerPolicy(policy());
      const first = await env.makeEnvelope();
      await inbox.recordAndEvaluate({ envelope: first.envelope });
      const changed = await env.makeEnvelope({
        rawBody: payload({ action: 'unlabeled' }),
      });
      await expect(
        inbox.recordAndEvaluate({ envelope: changed.envelope }),
      ).rejects.toThrow(IngressPolicyConflict);
      expect(
        (
          await inbox.readDelivery({
            tenantId: 'tenant-1',
            deliveryId: 'delivery-1',
          })
        )?.handoff,
      ).toEqual(
        (await inbox.recordAndEvaluate({ envelope: first.envelope })).record
          .handoff,
      );
    });

    it('isolates the same delivery ID across tenants', async () => {
      const clock = new ManualClock();
      const inbox = await makeInbox(clock, new MutableEvidenceResolver());
      await inbox.registerPolicy(policy());
      await inbox.registerPolicy(
        policy({ tenantId: 'tenant-2', repositoryId: 124 }),
      );
      const first = await environment({ clock });
      const second = await environment({
        clock,
        tenantId: 'tenant-2',
        repositoryId: 124,
        installationId: 457,
      });
      const firstEnvelope = (await first.makeEnvelope()).envelope;
      const secondEnvelope = (
        await second.makeEnvelope({
          rawBody: payload({ repositoryId: 124, installationId: 457 }),
        })
      ).envelope;
      expect(
        (await inbox.recordAndEvaluate({ envelope: firstEnvelope })).status,
      ).toBe('applied');
      expect(
        (await inbox.recordAndEvaluate({ envelope: secondEnvelope })).status,
      ).toBe('applied');
    });

    it('does not collide delimiter-bearing tenant and delivery IDs', async () => {
      const clock = new ManualClock();
      const inbox = await makeInbox(clock, new MutableEvidenceResolver());
      await inbox.registerPolicy(
        policy({ tenantId: 'a:b', repositoryId: 123 }),
      );
      await inbox.registerPolicy(policy({ tenantId: 'a', repositoryId: 124 }));
      const first = await environment({ clock, tenantId: 'a:b' });
      const second = await environment({
        clock,
        tenantId: 'a',
        repositoryId: 124,
        installationId: 457,
      });
      const firstEnvelope = (await first.makeEnvelope({ deliveryId: 'c' }))
        .envelope;
      const secondEnvelope = (
        await second.makeEnvelope({
          deliveryId: 'b:c',
          rawBody: payload({ repositoryId: 124, installationId: 457 }),
        })
      ).envelope;
      expect(firstEnvelope.factId).not.toBe(secondEnvelope.factId);
      expect(
        (await inbox.recordAndEvaluate({ envelope: firstEnvelope })).status,
      ).toBe('applied');
      expect(
        (await inbox.recordAndEvaluate({ envelope: secondEnvelope })).status,
      ).toBe('applied');
    });

    it('commits no inbox record when policy evaluation fails', async () => {
      const { inbox, env } = await makeHarness();
      const { envelope } = await env.makeEnvelope();
      await expect(inbox.recordAndEvaluate({ envelope })).rejects.toThrow(
        IngressPolicyConflict,
      );
      expect(
        await inbox.readDelivery({
          tenantId: envelope.tenant.tenantId,
          deliveryId:
            envelope.source.kind === 'github-webhook'
              ? envelope.source.deliveryId
              : 'invalid',
        }),
      ).toBeUndefined();
    });

    it('suppresses duplicate reducer handoff and emits no provider effects', async () => {
      const { inbox, env } = await makeHarness();
      await inbox.registerPolicy(policy());
      const { envelope } = await env.makeEnvelope();
      const applied = await inbox.recordAndEvaluate({ envelope });
      const replay = await inbox.recordAndEvaluate({ envelope });
      expect(prepareReducerIngressHandoff(applied)).toMatchObject({
        status: 'ready',
        effects: [],
        handoff: { envelope },
      });
      expect(prepareReducerIngressHandoff(replay)).toEqual({
        status: 'replay',
        effects: [],
      });
    });

    it('rejects a structurally forged normalized envelope', async () => {
      const { inbox, env, evidenceResolver } = await makeHarness();
      await inbox.registerPolicy(policy());
      const { envelope } = await env.makeEnvelope();
      const forged = structuredClone(envelope) as typeof envelope;
      await expect(
        inbox.recordAndEvaluate({ envelope: forged }),
      ).rejects.toThrow(IngressPolicyConflict);
      expect(evidenceResolver.calls).toBe(0);
    });

    it('registers policy revisions forward-only and replay-safe', async () => {
      const { inbox } = await makeHarness();
      const first = policy();
      expect(await inbox.registerPolicy(first)).toBe('applied');
      expect(await inbox.registerPolicy(first)).toBe('replay');
      await expect(
        inbox.registerPolicy(policy({ decision: 'rejected' })),
      ).rejects.toThrow(IngressPolicyConflict);
      expect(
        await inbox.registerPolicy(
          policy({ version: 2, decision: 'rejected' }),
        ),
      ).toBe('applied');
    });

    it('rejects malformed policy program vocabulary before persistence', async () => {
      const { inbox } = await makeHarness();
      const current = policy();
      const malformed = [
        {
          ...current,
          rules: [{ ...current.rules[0], decision: 'bogus' }],
        },
        {
          ...current,
          rules: [
            {
              ...current.rules[0],
              principal: { kind: 'bogus', systemIds: ['scheduler-1'] },
            },
          ],
        },
        {
          ...current,
          rules: [{ ...current.rules[0], sourceKinds: ['bogus-source'] }],
        },
      ];
      for (const candidate of malformed) {
        await expect(
          inbox.registerPolicy(candidate as RegisteredIngressPolicy),
        ).rejects.toThrow(IngressPolicyConflict);
      }
    });
  });
}

runIngressPolicyInboxContract(
  (clock, evidenceResolver) =>
    new InMemoryIngressPolicyInbox(clock, evidenceResolver),
);
