import 'server-only';

import { logger } from '@agent-lcars/logging';

export type OperatorCommentOutcome =
  'posted' | 'missing_token' | 'rejected_token' | 'failed';

/**
 * One bounded event per comment the console tries to post as the signed-in
 * operator (replies, retry notes, Unstick context). Homelab's
 * homelab-lcars-webhooks census counts these from Cloud Logging, so repeated
 * sign-in failures alert instead of only showing a toast. Metadata only: no
 * login, repository, issue or comment text.
 */
export function recordOperatorComment(outcome: OperatorCommentOutcome): void {
  logger.structured(
    outcome === 'posted' ? 'info' : 'warn',
    'LCARS operator comment outcome',
    { component: 'lcars-operator-comment', outcome },
    { enrich: false },
  );
}
