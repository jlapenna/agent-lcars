import 'server-only';

import type { InboxCard } from '../app/inbox-card';
import { inboxCardKey } from '../app/inbox-card';
import { context as workContext } from '../app/work/context';
import { auth } from '../auth';
import {
  getCachedAgentActivity,
  getCachedQueueItems,
  oldestFetchedAt,
} from './dashboard-data';
import type {
  InboxNotificationSnapshot,
  NotificationDecision,
} from './inbox-notifications';
import { NOTIFICATION_FRESH_MS } from './inbox-notifications';
import { getNativeInboxCards } from './native-inbox';
import { buildQueueView } from './queue-view';
import { getRunnerSessionsByRunId } from './runner-sessions';

export function notificationDecisions(
  cards: readonly InboxCard[],
): NotificationDecision[] {
  return cards.flatMap((card) => {
    if ('work' in card) {
      if (card.work.state !== 'parked' || !card.canReply) return [];
      return [
        {
          id: inboxCardKey(card),
          generation: card.work.runs.at(-1)?.runId ?? card.work.updatedAt,
        },
      ];
    }
    // The product's notification trigger is an explicit human handoff.
    // Failed checks, edits and ordinary metadata changes do not spam it.
    if (!card.item.actionTypes.includes('needs-human')) return [];
    return [{ id: inboxCardKey(card), generation: 'needs-human' }];
  });
}

/** Re-check both session and native Work grants immediately before display.
 * This returns only authorized identifiers, never user content or credentials. */
export async function loadInboxNotificationSnapshot(): Promise<InboxNotificationSnapshot> {
  const session = await auth();
  if (!session?.user?.isAdmin || !session.user.id)
    throw new Error('Unauthorized');
  const nativeReadStartedAt = Date.now();
  const [queue, activity, sessions, native] = await Promise.all([
    getCachedQueueItems(),
    getCachedAgentActivity(),
    getRunnerSessionsByRunId(),
    workContext().then((ctx) =>
      getNativeInboxCards(ctx.runtime.store, ctx.principal),
    ),
  ]);
  const now = Date.now();
  const view = buildQueueView(
    queue.data.items,
    activity.data,
    sessions.sessionsByRunId,
  );
  const dataAsOf = Date.parse(
    oldestFetchedAt(queue.fetchedAt, activity.fetchedAt),
  );
  return {
    principalId: session.user.id,
    observedAt: Math.min(dataAsOf, nativeReadStartedAt),
    sourceTimes: {
      queue: Date.parse(queue.fetchedAt),
      activity: Date.parse(activity.fetchedAt),
      native: nativeReadStartedAt,
    },
    available:
      activity.data.warnings.length === 0 &&
      sessions.warnings.length === 0 &&
      Number.isFinite(dataAsOf) &&
      dataAsOf <= now &&
      now - dataAsOf < NOTIFICATION_FRESH_MS,
    decisions: notificationDecisions([
      ...view.yourQueue.map((item) => ({ item })),
      ...native,
    ]),
  };
}
