import { z } from 'zod';

import { attemptTerminalStateSchema } from './observation';
import {
  attemptIdSchema,
  opaqueIdSchema,
  utcDateTimeSchema,
} from './primitives';

const MAX_INSTALLATION_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

export const credentialGrantRequestSchema = z.strictObject({
  schema: z.literal('agent-lcars.credential-grant-request/v1'),
  version: z.literal(1),
  requestId: opaqueIdSchema,
  attemptId: attemptIdSchema,
});
export type CredentialGrantRequest = z.infer<
  typeof credentialGrantRequestSchema
>;

export const grantDenialCodeSchema = z.enum([
  'oidc_invalid',
  'binding_mismatch',
  'profile_denied',
  'attempt_not_active',
  'attempt_cancelled',
  'attempt_superseded',
  'attempt_expired',
  'renewal_deadline_elapsed',
  'jti_replayed',
  'request_replayed',
  'already_issued_no_replay',
  'mint_in_progress',
  'mint_unknown',
  'tenant_mismatch',
  'service_unavailable',
]);
export type GrantDenialCode = z.infer<typeof grantDenialCodeSchema>;

export const grantMintStateSchema = z.enum([
  'not-started',
  'mint-in-progress',
  'minted',
  'mint-unknown',
]);
export type GrantMintState = z.infer<typeof grantMintStateSchema>;

export const grantIssuanceStateSchema = z.enum([
  'pending',
  'issued',
  'denied',
  'terminal',
]);
export type GrantIssuanceState = z.infer<typeof grantIssuanceStateSchema>;

/** Metadata retained for grant audit. It intentionally has no token field. */
const issuanceBase = {
  grantId: opaqueIdSchema,
  attemptId: attemptIdSchema,
  requestId: opaqueIdSchema,
  credentialProfileId: opaqueIdSchema,
};
export const credentialGrantIssuanceSchema = z
  .discriminatedUnion('issuanceState', [
    z.strictObject({
      ...issuanceBase,
      issuanceState: z.literal('pending'),
      mintState: z.enum(['not-started', 'mint-in-progress']),
      mintStartedAt: utcDateTimeSchema.optional(),
    }),
    z.strictObject({
      ...issuanceBase,
      issuanceState: z.literal('issued'),
      mintState: z.literal('minted'),
      issuedAt: utcDateTimeSchema,
      tokenExpiresAt: utcDateTimeSchema,
      maxResidualTokenExpiry: utcDateTimeSchema,
      tokenFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
    z.strictObject({
      ...issuanceBase,
      issuanceState: z.literal('denied'),
      mintState: z.enum(['not-started', 'mint-unknown']),
      denialCode: grantDenialCodeSchema,
      mintStartedAt: utcDateTimeSchema.optional(),
      maxResidualTokenExpiry: utcDateTimeSchema.optional(),
    }),
    z.strictObject({
      ...issuanceBase,
      issuanceState: z.literal('terminal'),
      mintState: z.literal('not-started'),
      terminalState: attemptTerminalStateSchema,
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.issuanceState === 'pending') {
      const hasMintStart = value.mintStartedAt !== undefined;
      if ((value.mintState === 'mint-in-progress') !== hasMintStart) {
        ctx.addIssue({
          code: 'custom',
          path: ['mintStartedAt'],
          message: 'A mint-in-progress record requires its exact start time',
        });
      }
      return;
    }
    if (
      value.issuanceState === 'denied' &&
      value.mintState === 'mint-unknown'
    ) {
      if (value.denialCode !== 'mint_unknown') {
        ctx.addIssue({
          code: 'custom',
          path: ['denialCode'],
          message: 'Unknown mint state requires the mint_unknown denial',
        });
      }
      if (
        value.mintStartedAt === undefined ||
        value.maxResidualTokenExpiry === undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['maxResidualTokenExpiry'],
          message: 'Unknown mint state requires its residual exposure window',
        });
      } else {
        const mintStartedAt = Date.parse(value.mintStartedAt);
        const residualExpiresAt = Date.parse(value.maxResidualTokenExpiry);
        if (
          residualExpiresAt <= mintStartedAt ||
          residualExpiresAt > mintStartedAt + MAX_INSTALLATION_TOKEN_LIFETIME_MS
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['maxResidualTokenExpiry'],
            message: 'Unknown mint residual window must be within one hour',
          });
        }
      }
    }
    if (
      value.issuanceState === 'denied' &&
      value.mintState === 'not-started' &&
      value.denialCode === 'mint_unknown'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['denialCode'],
        message: 'The mint_unknown denial requires an unknown mint state',
      });
    }
    if (
      value.issuanceState === 'denied' &&
      value.mintState === 'not-started' &&
      (value.mintStartedAt !== undefined ||
        value.maxResidualTokenExpiry !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['mintStartedAt'],
        message: 'A non-minted denial has no residual token window',
      });
    }
    if (value.issuanceState !== 'issued') return;
    const issuedAt = Date.parse(value.issuedAt);
    const tokenExpiresAt = Date.parse(value.tokenExpiresAt);
    const residualExpiresAt = Date.parse(value.maxResidualTokenExpiry);
    if (tokenExpiresAt <= issuedAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['tokenExpiresAt'],
        message: 'Token expiry must be after issuance',
      });
    }
    if (residualExpiresAt < tokenExpiresAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxResidualTokenExpiry'],
        message: 'Residual expiry cannot precede token expiry',
      });
    }
    if (
      tokenExpiresAt > issuedAt + MAX_INSTALLATION_TOKEN_LIFETIME_MS ||
      residualExpiresAt > issuedAt + MAX_INSTALLATION_TOKEN_LIFETIME_MS
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxResidualTokenExpiry'],
        message: 'Installation-token residual lifetime cannot exceed one hour',
      });
    }
  });
export type CredentialGrantIssuance = z.infer<
  typeof credentialGrantIssuanceSchema
>;

/** Result metadata is separate from the ephemeral token delivery channel. */
export const credentialGrantResultSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('issued'),
      /** Ephemeral response data; never part of CredentialGrantIssuance. */
      token: z.string().min(1),
      grantId: opaqueIdSchema,
      credentialProfileId: opaqueIdSchema,
      issuedAt: utcDateTimeSchema,
      tokenExpiresAt: utcDateTimeSchema,
      renewalDeadline: utcDateTimeSchema,
      maxResidualTokenExpiry: utcDateTimeSchema,
    }),
    z.strictObject({
      kind: z.literal('denied'),
      code: grantDenialCodeSchema,
      retryAfter: utcDateTimeSchema.optional(),
    }),
    z.strictObject({
      kind: z.literal('terminal'),
      terminalState: attemptTerminalStateSchema,
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.kind !== 'issued') return;
    const issuedAt = Date.parse(value.issuedAt);
    const tokenExpiresAt = Date.parse(value.tokenExpiresAt);
    const renewalDeadline = Date.parse(value.renewalDeadline);
    const residualExpiresAt = Date.parse(value.maxResidualTokenExpiry);
    if (tokenExpiresAt <= issuedAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['tokenExpiresAt'],
        message: 'Token expiry must be after issuance',
      });
    }
    if (renewalDeadline <= issuedAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['renewalDeadline'],
        message: 'Renewal deadline must be after issuance',
      });
    }
    if (residualExpiresAt < tokenExpiresAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxResidualTokenExpiry'],
        message: 'Residual expiry cannot precede token expiry',
      });
    }
    if (
      tokenExpiresAt > issuedAt + MAX_INSTALLATION_TOKEN_LIFETIME_MS ||
      residualExpiresAt > issuedAt + MAX_INSTALLATION_TOKEN_LIFETIME_MS
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxResidualTokenExpiry'],
        message: 'Installation-token residual lifetime cannot exceed one hour',
      });
    }
  });
export type CredentialGrantResult = z.infer<typeof credentialGrantResultSchema>;
