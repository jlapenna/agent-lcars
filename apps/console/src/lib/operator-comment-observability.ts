import 'server-only';

import { logger } from '@agent-lcars/logging';

import type { OperatorTokenRecord } from './operator-token-check';

export type OperatorCommentOutcome =
  'posted' | 'missing_token' | 'rejected_token' | 'failed';

/**
 * One bounded event per comment the console tries to post as the signed-in
 * operator (replies, retry notes, Unstick context). Homelab's
 * homelab-lcars-webhooks census counts these from Cloud Logging, so repeated
 * sign-in failures alert instead of only showing a toast. Metadata only: no
 * login, repository, issue or comment text.
 */
export function recordOperatorComment(
  outcome: OperatorCommentOutcome,
  rejection?: OperatorTokenRejection,
): void {
  logger.structured(
    outcome === 'posted' ? 'info' : 'warn',
    'LCARS operator comment outcome',
    {
      component: 'lcars-operator-comment',
      outcome,
      ...(rejection?.tokenAgeSeconds === undefined
        ? {}
        : { tokenAgeSeconds: rejection.tokenAgeSeconds }),
      ...(rejection?.githubMessage === undefined
        ? {}
        : { githubMessage: rejection.githubMessage }),
      ...(rejection?.githubRequestId === undefined
        ? {}
        : { githubRequestId: rejection.githubRequestId }),
      ...(rejection?.tokenRecord === undefined
        ? {}
        : { tokenRecord: rejection.tokenRecord }),
      ...(rejection?.tokenRecordCreatedAt === undefined
        ? {}
        : { tokenRecordCreatedAt: rejection.tokenRecordCreatedAt }),
      ...(rejection?.tokenRecordExpiresAt === undefined
        ? {}
        : { tokenRecordExpiresAt: rejection.tokenRecordExpiresAt }),
    },
    { enrich: false },
  );
}

/**
 * Why GitHub refused an operator token, as far as the console can see: how
 * long ago that token was issued, GitHub's own short reason and request id,
 * and whether GitHub's token registry still lists it. None of these
 * identifies the operator or the token.
 */
export interface OperatorTokenRejection extends Partial<OperatorTokenRecord> {
  tokenAgeSeconds?: number;
  githubMessage?: string;
  githubRequestId?: string;
}

/**
 * One event per GitHub sign-in describing the kind of user token GitHub
 * issued, never the token: its public type prefix, whether GitHub gave it an
 * expiry, and whether a refresh token came with it. Together with
 * `tokenAgeSeconds` on a later rejection this separates a token that expired
 * on schedule from one GitHub revoked.
 */
export function recordOperatorTokenIssued(account: {
  access_token?: unknown;
  expires_at?: unknown;
  refresh_token?: unknown;
}): void {
  const token =
    typeof account.access_token === 'string' ? account.access_token : '';
  logger.structured(
    'info',
    'LCARS operator token issued',
    {
      component: 'lcars-operator-token',
      // GitHub's documented, non-secret token type prefixes (`gho`, `ghu`).
      tokenKind: /^gh[a-z]_/.exec(token)?.[0].slice(0, 3) ?? 'other',
      expiresInSeconds:
        typeof account.expires_at === 'number'
          ? Math.round(account.expires_at - Date.now() / 1000)
          : null,
      refreshable: typeof account.refresh_token === 'string',
    },
    { enrich: false },
  );
}

export type OperatorTokenRefreshOutcome = 'refreshed' | 'refused' | 'failed';

/**
 * One event per attempt to renew an expired operator token with its refresh
 * token. `refused` means GitHub rejected the refresh token, so the operator
 * is sent back through GitHub; `failed` means GitHub did not answer. Carries
 * the old token's age and GitHub's short error code, never a token.
 */
export function recordOperatorTokenRefresh(
  outcome: OperatorTokenRefreshOutcome,
  detail: {
    tokenAgeSeconds?: number | undefined;
    githubError?: string | undefined;
  } = {},
): void {
  logger.structured(
    outcome === 'refreshed' ? 'info' : 'warn',
    'LCARS operator token refresh outcome',
    {
      component: 'lcars-operator-token-refresh',
      outcome,
      ...(detail.tokenAgeSeconds === undefined
        ? {}
        : { tokenAgeSeconds: detail.tokenAgeSeconds }),
      ...(detail.githubError === undefined
        ? {}
        : { githubError: detail.githubError }),
    },
    { enrich: false },
  );
}
