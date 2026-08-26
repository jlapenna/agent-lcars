// This test does real WebCrypto RS256 signing (via jose's `SignJWT`): under
// the workspace-default jsdom environment, that fails with "payload must be
// an instance of Uint8Array" -- jsdom's window is torn down and rebuilt
// between Vitest's collection and run phases, so `jose`'s module-scoped
// `TextEncoder` (created once, at collection time) produces `Uint8Array`
// instances from a different realm than the one active when signing
// actually runs (see github-app-tokens.test.ts for the same fix).
// `work-auth.ts` itself is server-only (no DOM), so running this file in
// the real `node` environment sidesteps the mismatch entirely.
// @vitest-environment node

import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { googleIdTokenVerifier } from './work-auth';

/**
 * Covers `googleIdTokenVerifier`'s actual signature-verification path
 * (issuer, audience, `email_verified`), which `work-auth.test.ts` never
 * exercises -- it only fakes `verifyGoogleIdToken` at the `WorkAuthDeps`
 * boundary. A local key pair + a local JWKS (rather than the real,
 * network-fetched Google JWKS) keeps this hermetic while still going
 * through the real `jose` verification code.
 */
const AUDIENCE = 'agent-lcars-work';
const ISSUER = 'https://accounts.google.com';
const EMAIL = 'sa@example.iam.gserviceaccount.com';

describe('googleIdTokenVerifier', () => {
  let jwks: ReturnType<typeof createLocalJWKSet>;
  let privateKey: CryptoKey;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), alg: 'RS256' };
    jwks = createLocalJWKSet({ keys: [jwk] });
  });

  function sign(
    claims: Record<string, unknown>,
    over: { issuer?: string; audience?: string } = {},
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(over.issuer ?? ISSUER)
      .setAudience(over.audience ?? AUDIENCE)
      .setExpirationTime('10m')
      .sign(privateKey);
  }

  it('accepts a correctly-issued, verified-email token', async () => {
    const verify = googleIdTokenVerifier(AUDIENCE, jwks);
    const token = await sign({ email: EMAIL, email_verified: true });
    await expect(verify(token)).resolves.toEqual({
      email: EMAIL,
      emailVerified: true,
    });
  });

  it('rejects a token issued by the wrong issuer', async () => {
    const verify = googleIdTokenVerifier(AUDIENCE, jwks);
    const token = await sign(
      { email: EMAIL, email_verified: true },
      { issuer: 'https://evil.example' },
    );
    await expect(verify(token)).rejects.toThrow();
  });

  it('rejects a token issued for the wrong audience', async () => {
    const verify = googleIdTokenVerifier(AUDIENCE, jwks);
    const token = await sign(
      { email: EMAIL, email_verified: true },
      { audience: 'someone-else' },
    );
    await expect(verify(token)).rejects.toThrow();
  });

  it('reports email_verified: false as-is rather than rejecting', async () => {
    const verify = googleIdTokenVerifier(AUDIENCE, jwks);
    const token = await sign({ email: EMAIL, email_verified: false });
    await expect(verify(token)).resolves.toEqual({
      email: EMAIL,
      emailVerified: false,
    });
  });
});
