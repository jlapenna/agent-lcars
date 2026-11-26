import 'server-only';

import {
  MAX_EVENT_RESUMES,
  type OrchestratorStore,
} from '@agent-lcars/orchestrator';
import {
  subscriptionMatches,
  validateSubscriptionRequest,
} from '@agent-lcars/work';
import type { WorkSummary } from '@agent-lcars/work/derive';

import type { AgentEventSubscriptionStore } from './agent-event-store';

/** The worker protocol's event-wait header declares intent; only a matching
 * subscription (or its accepted event) and remaining budget establish an automatic
 * wait. A stale subscription alone must never hide a later human handoff. */
export async function readNativeEventWait(
  store: OrchestratorStore,
  subscriptions: AgentEventSubscriptionStore,
  work: WorkSummary,
): Promise<{ key: string; kind: string; subscriptionId: string } | undefined> {
  if (work.state !== 'parked' || !('workId' in work.anchor)) return undefined;
  const header = work.runs
    .at(-1)
    ?.result?.message?.trimStart()
    .split(/\r?\n/, 1)[0];
  const match = header?.match(
    /^Waiting on event: (\S+) ([a-z][a-z-]*) \(subscription ([a-f0-9]{32})\)$/u,
  );
  if (!match) return undefined;
  const [, key, kind, subscriptionId] = match as [
    string,
    string,
    string,
    string,
  ];
  const validated = validateSubscriptionRequest({ key, kinds: [kind] });
  if (!validated.ok) return undefined;
  const [subscription, current] = await Promise.all([
    subscriptions.get(subscriptionId),
    store.readTask(work.anchor),
  ]);
  if (
    current === undefined ||
    current.task.closedAt !== undefined ||
    current.task.activeRunId !== undefined ||
    current.task.eventResumes?.canceledAt !== undefined ||
    (current.task.eventResumes?.admitted ?? 0) >= MAX_EVENT_RESUMES
  )
    return undefined;
  const subscribed =
    subscription?.target.type === 'work' &&
    subscription.target.workId === work.anchor.workId &&
    subscriptionMatches(subscription, { key: validated.value.key, kind });
  // An `until` event removes its subscription after accepting the resume.
  // Keep that durable handoff out of the human queue while the outbox drains.
  const accepted = current.task.eventResumes?.pending.some((event) =>
    event.deliveryId.startsWith(`${subscriptionId}:`),
  );
  if (!subscribed && !accepted) return undefined;
  return { key: validated.value.key, kind, subscriptionId };
}
