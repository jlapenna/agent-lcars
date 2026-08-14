import 'server-only';

import type { LifecycleAuthorityStorage } from './authority-storage';
import {
  CredentialGrantHttpHandler,
  type CredentialGrantHttpIssueService,
  type CredentialGrantHttpOidcBoundary,
} from './credential-grant-http';
import {
  CredentialGrantCoordinator,
  type ExpectedWorkerGrantOidcSource,
  type GrantTenantResolver,
  WorkerGrantOidcBoundary,
  type WorkerGrantOidcVerifier,
} from './credential-grant-oidc';
import {
  type InstallationTokenMinter,
  InstallationTokenMinterBoundary,
} from './mint-resolution';

/** Dependencies owned by the inactive server-side CredentialGrant composition. */
export interface CredentialGrantCompositionDependencies {
  storage: LifecycleAuthorityStorage;
  tenants: GrantTenantResolver;
  minter: InstallationTokenMinter;
  oidc: WorkerGrantOidcVerifier;
  expectedOidcSource: ExpectedWorkerGrantOidcSource;
  clock: { now(): string };
}

/**
 * Build the inactive CredentialGrant pipeline from explicitly supplied seams.
 *
 * This factory deliberately has no defaults: selecting storage, a tenant
 * registry, a secret source, a provider, or an HTTP route belongs to a later,
 * separately approved integration.
 */
export function createCredentialGrantComposition(
  dependencies: CredentialGrantCompositionDependencies,
): CredentialGrantHttpHandler {
  const oidcBoundary: CredentialGrantHttpOidcBoundary =
    new WorkerGrantOidcBoundary(
      dependencies.oidc,
      dependencies.expectedOidcSource,
      dependencies.clock,
    );
  const minterBoundary = new InstallationTokenMinterBoundary(
    dependencies.minter,
    dependencies.clock,
  );
  const coordinator: CredentialGrantHttpIssueService =
    new CredentialGrantCoordinator(
      dependencies.storage,
      dependencies.tenants,
      minterBoundary,
      dependencies.clock,
    );
  return new CredentialGrantHttpHandler(oidcBoundary, coordinator);
}
