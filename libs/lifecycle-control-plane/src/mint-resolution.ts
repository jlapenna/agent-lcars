import { createHash } from 'node:crypto';

import type { CredentialGrantIssuance } from '@agent-lcars/dispatch-contracts';
import {
  credentialGrantIssuanceSchema,
  utcDateTimeSchema,
} from '@agent-lcars/dispatch-contracts';

const verifiedMintResolutions = new WeakSet<object>();
const MAX_INSTALLATION_TOKEN_LIFETIME_MS = 60 * 60 * 1_000;

export interface InstallationTokenMintPlan {
  installationId: number;
  repositoryId: number;
  credentialProfileId: string;
}

export type MintResponse =
  | { kind: 'issued'; token: string; tokenExpiresAt: string }
  | { kind: 'definitely-not-started' };

export interface InstallationTokenMinter {
  mint(plan: InstallationTokenMintPlan): Promise<MintResponse>;
}

export interface VerifiedMintResolution {
  readonly issuance: CredentialGrantIssuance;
  readonly token?: string;
}

export function isVerifiedMintResolution(
  value: unknown,
): value is VerifiedMintResolution {
  return (
    value !== null &&
    typeof value === 'object' &&
    verifiedMintResolutions.has(value)
  );
}

/** Converts only a well-formed injected minter response into durable metadata. */
export class InstallationTokenMinterBoundary {
  constructor(
    private readonly minter: InstallationTokenMinter,
    private readonly clock: { now(): string },
  ) {}

  async mint(
    plan: InstallationTokenMintPlan,
    pending: Extract<CredentialGrantIssuance, { issuanceState: 'pending' }>,
  ): Promise<VerifiedMintResolution> {
    const response = await this.minter.mint(plan);
    let resolution: VerifiedMintResolution;
    if (response.kind === 'issued') {
      if (
        response.token.length === 0 ||
        !utcDateTimeSchema.safeParse(response.tokenExpiresAt).success
      ) {
        throw new Error('Minter response is malformed');
      }
      const issuedAt = this.clock.now();
      const issuedAtMs = Date.parse(issuedAt);
      const tokenExpiresAtMs = Date.parse(response.tokenExpiresAt);
      if (
        !utcDateTimeSchema.safeParse(issuedAt).success ||
        tokenExpiresAtMs <= issuedAtMs ||
        tokenExpiresAtMs - issuedAtMs > MAX_INSTALLATION_TOKEN_LIFETIME_MS
      ) {
        throw new Error('Minter response violates the grant lifetime contract');
      }
      resolution = Object.freeze({
        token: response.token,
        issuance: Object.freeze({
          grantId: pending.grantId,
          attemptId: pending.attemptId,
          requestId: pending.requestId,
          credentialProfileId: pending.credentialProfileId,
          issuanceState: 'issued',
          mintState: 'minted',
          issuedAt,
          tokenExpiresAt: response.tokenExpiresAt,
          maxResidualTokenExpiry: response.tokenExpiresAt,
          tokenFingerprint: createHash('sha256')
            .update(response.token)
            .digest('hex'),
        }),
      });
    } else if (response.kind === 'definitely-not-started') {
      resolution = Object.freeze({
        issuance: Object.freeze({
          grantId: pending.grantId,
          attemptId: pending.attemptId,
          requestId: pending.requestId,
          credentialProfileId: pending.credentialProfileId,
          issuanceState: 'denied',
          mintState: 'not-started',
          denialCode: 'service_unavailable',
        }),
      });
    } else {
      throw new Error('Minter response is malformed');
    }
    if (!credentialGrantIssuanceSchema.safeParse(resolution.issuance).success) {
      throw new Error('Minter response violates the grant lifetime contract');
    }
    verifiedMintResolutions.add(resolution);
    return resolution;
  }
}
