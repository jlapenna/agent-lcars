import { createHmac } from 'node:crypto';

import type { PolicyDecision } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import type { AuthorityClock } from './authority-storage';
import {
  GitHubWebhookNormalizer,
  GitHubWebhookVerifier,
  IngressPolicyConflict,
  ingressPolicyContentSha256,
  InMemoryIngressPolicyInbox,
  InMemoryTenantRegistrationRegistry,
  NodeWebhookHmacSha256,
  type PolicyEvidenceResolver,
  type RegisteredIngressPolicy,
  type VerifiedGitHubWebhookReceipt,
  type WebhookVerificationKey,
} from './ingress-policy';

const T0 = '2026-08-16T00:00:00.000Z';
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
    expect(result.record.policyEvidence).toEqual({
      principal: evidence().principal,
      roles: ['maintainer'],
      evidenceRef: 'role-proof-789',
    });
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

import { runIngressPolicyInboxContract } from './ingress-policy.spec.support';

runIngressPolicyInboxContract(
  (clock, evidenceResolver) =>
    new InMemoryIngressPolicyInbox(clock, evidenceResolver),
);
