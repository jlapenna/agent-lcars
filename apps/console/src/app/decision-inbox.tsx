import type { ReactNode } from 'react';

import { getWatchedRepos } from '../lib/github-client';
import type { InboxCard } from './inbox-card';
import { QueueWorkspace } from './queue-workspace';
import { renderInboxCardMarkdown } from './render-card-markdown';
import type { ReplyAction } from './work/work-actions';

/** The standalone master/detail surface for work awaiting a decision. */
export function DecisionInbox({
  yourQueue,
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
      cards={yourQueue.map(renderInboxCardMarkdown)}
      selectedCard={selectedCard && renderInboxCardMarkdown(selectedCard)}
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
