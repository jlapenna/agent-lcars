import 'server-only';

import { Suspense } from 'react';

import {
  getInboxDecisionSummary,
  inboxDecisionContext,
} from '../lib/inbox-decision-summary';
import { type InboxCard, nativeCardText } from './inbox-card';

export async function InboxDecisionDescription({
  context,
  fallback,
}: {
  context: string;
  fallback: string;
}) {
  const description = await getInboxDecisionSummary(context);
  return description ? (
    <span title="AI-generated summary; verify against the original context">
      {description}
    </span>
  ) : (
    <span role="status" aria-label="Decision summary">
      Summary unavailable. {fallback}
    </span>
  );
}

/** Server-rendered slot: the queue and its reply controls remain usable while
 * the optional model call is pending. Never ship credentials to the client. */
export function withInboxDecisionSummary(card: InboxCard): InboxCard {
  const fallback =
    'work' in card
      ? nativeCardText(card)
      : 'Read the original context for the decision.';
  return {
    ...card,
    decisionSummary: (
      <Suspense
        fallback={
          <span role="status" aria-label="Decision summary">
            Generating summary… {fallback}
          </span>
        }
      >
        <InboxDecisionDescription
          context={inboxDecisionContext(card)}
          fallback={fallback}
        />
      </Suspense>
    ),
  };
}
