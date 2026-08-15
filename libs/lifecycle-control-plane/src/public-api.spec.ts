// This test intentionally imports the package entrypoint rather than a
// relative source file to lock the published surface.
// eslint-disable-next-line @nx/enforce-module-boundaries
import * as api from '@agent-lcars/lifecycle-control-plane';
import { describe, expect, it } from 'vitest';

describe('lifecycle-control-plane public API', () => {
  it('keeps lease-owning compositions available', () => {
    expect(api.AttemptFinalizationComposition).toBeDefined();
    expect(api.CancellationTaskEffectComposition).toBeDefined();
    expect(api.LaunchOutboxComposition).toBeDefined();
    expect(api.PresentationDeliveryComposition).toBeDefined();
    expect(api.RunBindingIngressComposition).toBeDefined();
    expect(api.SignalTaskComposition).toBeDefined();
    expect(api.TaskAdmissionEffectComposition).toBeDefined();
    expect(api.createCredentialGrantComposition).toBeDefined();
    expect(api.GitHubInstallationTokenMinter).toBeDefined();
    expect(api.GitHubWebhookNormalizer).toBeDefined();
    expect(api.GitHubWebhookVerifier).toBeDefined();
    expect(api.GitHubWorkerGrantOidcVerifier).toBeDefined();
    expect(api.RunBindingIngressVerifier).toBeDefined();
    expect(api.LaunchResponseBoundary).toBeDefined();
    expect(api.GITHUB_ACTIONS_OIDC_ISSUER).toBe(
      'https://token.actions.githubusercontent.com',
    );
    expect(api.CREDENTIAL_GRANT_OIDC_AUDIENCE).toBe(
      'agent-lcars/credential-grant/v1',
    );
  });

  it('constructs hosted-safe seams with inert fakes without provider calls', () => {
    const clock = { now: () => '2026-08-21T00:00:00.000Z' };
    const storage = {} as api.LifecycleAuthorityStorage;
    const leases = {
      run: async <T>(
        _scope: api.TaskAuthorityScope,
        operation: (lease: api.TaskAuthorityLease) => Promise<T>,
      ) => operation({} as api.TaskAuthorityLease),
    } satisfies api.TaskLeaseRunner;
    const hmac = new api.NodeWebhookHmacSha256();
    const webhookVerifier = new api.GitHubWebhookVerifier(
      { resolveKeys: async () => [] },
      hmac,
      clock,
    );
    const webhookNormalizer = new api.GitHubWebhookNormalizer(
      { resolve: async () => undefined },
      { interpret: async () => undefined },
    );
    const launchResponse = new api.LaunchResponseBoundary(
      {
        resolve: async () => ({
          kind: 'unknown',
          responseSha256: 'a'.repeat(64),
        }),
      },
      clock,
    );
    const runBindingVerifier = new api.RunBindingIngressVerifier({
      verifyExactRunBinding: async () => undefined,
    });
    const compositions = [
      new api.SignalTaskComposition({
        webhookVerifier,
        webhookNormalizer,
        inbox: {} as api.IngressPolicyInbox,
        storage,
        activation: { resolve: async () => undefined },
        candidate: { resolve: async () => undefined },
        leases,
        clock,
      }),
      new api.TaskAdmissionEffectComposition({
        storage,
        plans: { resolve: async () => ({}) as never },
        leases,
      }),
      new api.LaunchOutboxComposition({
        storage,
        responses: launchResponse,
        leases,
        clock,
      }),
      new api.RunBindingIngressComposition({
        storage,
        verifier: runBindingVerifier,
        leases,
      }),
      new api.AttemptFinalizationComposition({
        storage,
        verifier: {
          verifyTerminal: async () => ({
            observedAt: clock.now(),
            finalizationDeadline: '2026-08-21T00:05:00.000Z',
          }),
          verifyClaim: async () => ({ observedAt: clock.now() }),
        },
        resolver: { resolve: async () => ({ status: 'validated' }) },
        clock,
        leases,
      }),
      new api.PresentationDeliveryComposition({
        storage,
        receiver: { receive: async () => ({ receiptSha256: 'b'.repeat(64) }) },
        clock,
        leases,
      }),
      new api.CancellationTaskEffectComposition({ storage, clock, leases }),
      api.createCredentialGrantComposition({
        storage,
        tenants: { resolve: async () => undefined },
        minter: { mint: async () => ({ kind: 'unknown' }) },
        oidc: { verify: async () => ({}) as never },
        expectedOidcSource: {
          issuer: api.GITHUB_ACTIONS_OIDC_ISSUER,
          audience: api.CREDENTIAL_GRANT_OIDC_AUDIENCE,
          sourceId: 'inert-source',
        },
        clock,
      }),
    ];
    expect(compositions).toHaveLength(8);
  });

  it('does not expose raw lease or capability operation entrypoints', () => {
    const forbidden = [
      'AdmissionTaskEffectCoordinator',
      'AttemptFinalizer',
      'CancellationTaskEffectCoordinator',
      'CredentialGrantCoordinator',
      'LaunchResolutionCoordinator',
      'PresentationDeliveryCoordinator',
      'TaskAttemptAdmissionCoordinator',
      'TaskEffectTransitionCoordinator',
      'ingestVerifiedRunBinding',
      'mintFinalizationTransition',
      'mintVerifiedCancellationEffect',
    ] as const;

    for (const name of forbidden) {
      expect(name in api).toBe(false);
    }
  });
});

// Compile-only hosted wiring fixture: these are the safe seams a future
// backend may select, while the root still withholds raw operation writers.
type HostedFactorySeams = {
  hmac: api.WebhookHmacSha256;
  keyResolver: api.WebhookVerificationKeyResolver;
  tenantRegistry: api.TenantRegistrationRegistry;
  signalInterpreter: api.GitHubSignalInterpreter;
  inbox: api.IngressPolicyInbox;
  profileResolver: api.GitHubCredentialProfileResolver;
  bearerProvider: api.GitHubAppBearerTokenProvider;
  admissionPlan: api.AdmissionPlanResolver;
  cancellationClock: api.CancellationEffectClock;
  launchResponse: api.LaunchResponseBoundary;
  oidcVerifier: api.WorkerGrantOidcVerifier;
  runBindingVerifier: api.RunBindingIngressVerifier;
};

type HostedFactoryValues = {
  hmac: typeof api.NodeWebhookHmacSha256;
  webhookVerifier: typeof api.GitHubWebhookVerifier;
  webhookNormalizer: typeof api.GitHubWebhookNormalizer;
  installationMinter: typeof api.GitHubInstallationTokenMinter;
  oidcVerifier: typeof api.GitHubWorkerGrantOidcVerifier;
  runBindingVerifier: typeof api.RunBindingIngressVerifier;
};

const hostedFactoryCanNameSafeSeams = (
  seams: HostedFactorySeams,
  values: HostedFactoryValues,
): [HostedFactorySeams, HostedFactoryValues] => [seams, values];
void hostedFactoryCanNameSafeSeams;

// This type-level assertion makes declaration generation fail if a forbidden
// operation is accidentally re-added to the root barrel.
type ForbiddenRootName = Extract<
  keyof typeof api,
  | 'AdmissionTaskEffectCoordinator'
  | 'AttemptFinalizer'
  | 'CancellationTaskEffectCoordinator'
  | 'CredentialGrantCoordinator'
  | 'LaunchResolutionCoordinator'
  | 'PresentationDeliveryCoordinator'
  | 'TaskAttemptAdmissionCoordinator'
  | 'TaskEffectTransitionCoordinator'
  | 'ingestVerifiedRunBinding'
  | 'mintFinalizationTransition'
  | 'mintVerifiedCancellationEffect'
>;
const forbiddenRootNameIsAbsent: ForbiddenRootName extends never
  ? true
  : never = true;
void forbiddenRootNameIsAbsent;
