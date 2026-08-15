// This fixture intentionally uses only the lifecycle package root. Deep
// imports would bypass the sealed composition surface.
import * as lifecycle from '@agent-lcars/lifecycle-control-plane';
import { describe, expect, it, vi } from 'vitest';

import {
  createHostedLifecycleRuntime,
  type HostedLifecycleRuntimeDependencies,
} from './hosted-runtime';

function dependencies(
  overrides: Partial<HostedLifecycleRuntimeDependencies> = {},
): HostedLifecycleRuntimeDependencies {
  const clock = { now: () => '2026-08-14T19:00:00.000Z' };
  const storage = {} as lifecycle.LifecycleAuthorityStorage;
  const leases = {
    run: async <T>(
      _scope: lifecycle.TaskAuthorityScope,
      operation: (lease: lifecycle.TaskAuthorityLease) => Promise<T>,
    ) => operation({} as lifecycle.TaskAuthorityLease),
  } satisfies lifecycle.TaskLeaseRunner;
  const response = new lifecycle.LaunchResponseBoundary(
    {
      resolve: async () => ({
        kind: 'unknown' as const,
        responseSha256: 'a'.repeat(64),
      }),
    },
    clock,
  );
  const values: HostedLifecycleRuntimeDependencies = {
    storage,
    leases,
    clock,
    signals: {
      webhookVerifier: { verify: async () => ({}) as never },
      webhookNormalizer: { normalize: async () => ({}) as never },
      inbox: {} as lifecycle.IngressPolicyInbox,
      activation: { resolve: async () => undefined },
      candidate: { resolve: async () => undefined },
    },
    admissionEffects: { plans: { resolve: async () => ({}) as never } },
    launchOutbox: { responses: response },
    runBinding: {
      verifier: new lifecycle.RunBindingIngressVerifier({
        verifyExactRunBinding: async () => undefined,
      }),
    },
    cancellationEffects: {},
    finalization: {
      verifier: {
        verifyTerminal: async () => ({
          observedAt: clock.now(),
          finalizationDeadline: clock.now(),
        }),
        verifyClaim: async () => ({ observedAt: clock.now() }),
      },
      resolver: { resolve: async () => ({ status: 'validated' }) },
    },
    presentation: {
      receiver: { receive: async () => ({ receiptSha256: 'b'.repeat(64) }) },
    },
    credentialGrant: {
      tenants: { resolve: async () => undefined },
      minter: { mint: async () => ({ kind: 'unknown' }) },
      oidc: { verify: async () => ({}) as never },
      expectedOidcSource: {
        issuer: lifecycle.GITHUB_ACTIONS_OIDC_ISSUER,
        audience: lifecycle.CREDENTIAL_GRANT_OIDC_AUDIENCE,
        sourceId: 'test-source',
      },
    },
  };
  return { ...values, ...overrides };
}

describe('hosted lifecycle runtime', () => {
  it('exposes exactly the frozen operation groups', () => {
    const runtime = createHostedLifecycleRuntime(dependencies());

    expect(Object.keys(runtime)).toEqual([
      'signals',
      'admissionEffects',
      'launchOutbox',
      'runBinding',
      'cancellationEffects',
      'finalization',
      'presentation',
      'credentialGrant',
    ]);
    expect(Object.keys(runtime.signals)).toEqual(['handleWebhook']);
    expect(Object.keys(runtime.admissionEffects)).toEqual(['reconcile']);
    expect(Object.keys(runtime.launchOutbox)).toEqual(['reconcile']);
    expect(Object.keys(runtime.runBinding)).toEqual(['ingest']);
    expect(Object.keys(runtime.cancellationEffects)).toEqual(['reconcile']);
    expect(Object.keys(runtime.finalization)).toEqual([
      'recordTerminal',
      'recordClaim',
      'beginValidation',
      'resolveClaim',
      'finalize',
    ]);
    expect(Object.keys(runtime.presentation)).toEqual(['deliver']);
    expect(Object.keys(runtime.credentialGrant)).toEqual(['handle']);
    expect(Object.isFrozen(runtime)).toBe(true);
    for (const operationGroup of Object.values(runtime)) {
      expect(Object.isFrozen(operationGroup)).toBe(true);
      for (const operation of Object.values(operationGroup)) {
        expect(Object.isFrozen(operation)).toBe(true);
      }
    }
  });

  it('routes malformed identity to composition validation without leasing', async () => {
    const run = vi.fn(
      async <T>(
        _scope: lifecycle.TaskAuthorityScope,
        operation: (lease: lifecycle.TaskAuthorityLease) => Promise<T>,
      ) => operation({} as lifecycle.TaskAuthorityLease),
    );
    const runtime = createHostedLifecycleRuntime(
      dependencies({
        leases: { run },
      }),
    );

    await expect(
      runtime.admissionEffects.reconcile({
        tenantId: 'tenant-a',
        task: { tenantId: 'tenant-b', repositoryId: 1, issueNumber: 1 },
        sourceFactId: 'fact-1',
        effectKey: 'effect-1',
      }),
    ).rejects.toThrow('crosses tenant scope');
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps each operation boundary fail-closed with no retry or fallback', async () => {
    const run = vi.fn(
      async <T>(
        _scope: lifecycle.TaskAuthorityScope,
        operation: (lease: lifecycle.TaskAuthorityLease) => Promise<T>,
      ) => operation({} as lifecycle.TaskAuthorityLease),
    );
    const runtime = createHostedLifecycleRuntime(
      dependencies({ leases: { run } }),
    );

    await expect(
      runtime.launchOutbox.reconcile({
        tenantId: 'tenant-a',
        task: { tenantId: 'tenant-b', repositoryId: 1, issueNumber: 1 },
        attemptId: 'invalid',
      }),
    ).rejects.toThrow('crosses tenant scope');
    await expect(
      runtime.cancellationEffects.reconcile({
        tenantId: 'tenant-a',
        task: { tenantId: 'tenant-b', repositoryId: 1, issueNumber: 1 },
        sourceFactId: 'fact-1',
        effectKey: 'effect-1',
      }),
    ).rejects.toThrow('crosses tenant scope');
    await expect(
      runtime.presentation.deliver({ target: null as never }),
    ).rejects.toThrow('target is invalid');
    await expect(
      runtime.runBinding.ingest({ envelope: null, localAttemptMarker: null }),
    ).rejects.toThrow('ingress is invalid');
    await expect(
      runtime.finalization.beginValidation({
        tenantId: '',
        attemptId: 'invalid',
      }),
    ).rejects.toThrow('identity is invalid');

    const grantResponse = await runtime.credentialGrant.handle(
      new Request('https://example.test/grant', { method: 'GET' }),
    );
    expect(grantResponse.status).toBe(405);
    expect(Object.isFrozen(grantResponse)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('does not expose injected seams as facade properties', () => {
    const values = dependencies();
    const runtime = createHostedLifecycleRuntime(values);
    const properties = Object.values(runtime).flatMap((group) =>
      Object.values(group),
    );

    expect(properties).not.toContain(values.storage);
    expect(properties).not.toContain(values.leases);
    expect(properties).not.toContain(values.clock);
    expect(properties.every((value) => typeof value === 'function')).toBe(true);
  });
});
