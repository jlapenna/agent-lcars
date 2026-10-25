import type { ReactNode } from 'react';

import { getWatchedRepos } from '../lib/github-client';
import { type InboxCard, inboxCardKey } from './inbox-card';
import { withInboxDecisionSummary } from './inbox-decision-summary';
import { QueueWorkspace } from './queue-workspace';
import {
  renderInboxCardMarkdown,
  renderInboxListMarkdown,
} from './render-card-markdown';
import type { ReplyAction } from './work/work-actions';

/** The standalone master/detail surface for work awaiting a decision. */
export function DecisionInbox({
  yourQueue,
  sourceObservations,
  selectedCard,
  selectedItemKey,
  mobileDataFreshness,
  mobileScopeLabel,
  repoScoped,
  replyToWorkItem,
  toolbarStart,
  toolbarEnd,
}: {
  yourQueue: InboxCard[];
  sourceObservations: {
    native: Record<string, string>;
    github: Record<string, string>;
  };
  selectedCard?: InboxCard;
  selectedItemKey?: string;
  mobileDataFreshness?: ReactNode;
  mobileScopeLabel?: string;
  repoScoped?: boolean;
  replyToWorkItem?: ReplyAction;
  toolbarStart?: ReactNode;
  toolbarEnd?: ReactNode;
}) {
  const watchedRepos = getWatchedRepos();

  return (
    <QueueWorkspace
      cards={renderInboxListMarkdown(yourQueue, selectedItemKey).map((card) =>
        !selectedItemKey || inboxCardKey(card) === selectedItemKey
          ? withInboxDecisionSummary(
              card,
              'work' in card
                ? sourceObservations.native
                : sourceObservations.github,
            )
          : card,
      )}
      selectedCard={
        selectedCard &&
        withInboxDecisionSummary(
          renderInboxCardMarkdown(selectedCard),
          'work' in selectedCard
            ? sourceObservations.native
            : sourceObservations.github,
        )
      }
      selectedItemKey={selectedItemKey}
      watchedRepos={watchedRepos}
      mobileDataFreshness={mobileDataFreshness}
      mobileScopeLabel={mobileScopeLabel}
      repoScoped={repoScoped}
      replyToWorkItem={replyToWorkItem}
      toolbarStart={toolbarStart}
      toolbarEnd={toolbarEnd}
    />
  );
}
