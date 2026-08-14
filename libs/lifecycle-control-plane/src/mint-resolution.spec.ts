import type { CredentialGrantIssuance } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import {
  InstallationTokenMinterBoundary,
  isVerifiedMintResolution,
} from './mint-resolution';

const pending: Extract<CredentialGrantIssuance, { issuanceState: 'pending' }> =
  {
    grantId: 'grant-1',
    attemptId: 'A'.repeat(22),
    requestId: 'request-1',
    credentialProfileId: 'profile-1',
    issuanceState: 'pending',
    mintState: 'mint-in-progress',
    mintStartedAt: '2026-08-16T00:00:00.000Z',
  };
const plan = {
  installationId: 456,
  repositoryId: 123,
  credentialProfileId: 'profile-1',
};

describe('metadata-only mint resolution boundary', () => {
  it('returns the token only ephemerally and durable fingerprint metadata', async () => {
    const boundary = new InstallationTokenMinterBoundary(
      {
        async mint() {
          return {
            kind: 'issued' as const,
            token: 'ephemeral-token',
            tokenExpiresAt: '2026-08-16T01:00:00.000Z',
          };
        },
      },
      { now: () => '2026-08-16T00:01:00.000Z' },
    );
    const verified = await boundary.mint(plan, pending);
    expect(isVerifiedMintResolution(verified)).toBe(true);
    expect(verified.token).toBe('ephemeral-token');
    expect(verified.issuance).toMatchObject({
      issuanceState: 'issued',
      mintState: 'minted',
      issuedAt: '2026-08-16T00:01:00.000Z',
    });
    expect(verified.issuance).not.toHaveProperty('token');
  });

  it('marks only an explicit definite pre-send response as not-started', async () => {
    const boundary = new InstallationTokenMinterBoundary(
      {
        async mint() {
          return { kind: 'definitely-not-started' as const };
        },
      },
      { now: () => '2026-08-16T00:01:00.000Z' },
    );
    expect((await boundary.mint(plan, pending)).issuance).toMatchObject({
      issuanceState: 'denied',
      mintState: 'not-started',
      denialCode: 'service_unavailable',
    });
  });

  it('does not mint a capability for malformed results', async () => {
    const boundary = new InstallationTokenMinterBoundary(
      {
        async mint() {
          return { kind: 'issued', token: '', tokenExpiresAt: 'bad' } as never;
        },
      },
      { now: () => '2026-08-16T00:01:00.000Z' },
    );
    await expect(boundary.mint(plan, pending)).rejects.toThrow('malformed');
  });

  it('rejects invalid trusted time and overlong token lifetimes', async () => {
    for (const [issuedAt, tokenExpiresAt] of [
      ['not-a-time', '2026-08-16T01:00:00.000Z'],
      ['2026-08-16T00:01:00.000Z', '2026-08-16T02:00:00.000Z'],
    ]) {
      const boundary = new InstallationTokenMinterBoundary(
        {
          async mint() {
            return {
              kind: 'issued' as const,
              token: 'ephemeral-token',
              tokenExpiresAt,
            };
          },
        },
        { now: () => issuedAt },
      );
      await expect(boundary.mint(plan, pending)).rejects.toThrow(
        'lifetime contract',
      );
    }
  });
});
