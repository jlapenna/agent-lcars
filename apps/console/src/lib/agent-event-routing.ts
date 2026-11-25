import 'server-only';

import { logger } from '@agent-lcars/logging';
import { required } from '@agent-lcars/util-server';
import {
  type AgentEvent,
  type AgentEventDelivery,
  agentEventDeliveryId,
  agentEventSchema,
  eventEndsSubscription,
  renderAgentEventNotice,
  subscriptionMatches,
} from '@agent-lcars/work';
import { PubSub } from '@google-cloud/pubsub';

import type {
  AgentEventSubscriptionStore,
  StoredAgentEventSubscription,
} from './agent-event-store';
import type { WorkResumeOutcome, WorkResumeRequest } from './work-event-resume';

/** Publishes one delivery to the topic each host's delivery agent pulls. */
export interface AgentEventPublisher {
  publish(data: Buffer, attributes: Record<string, string>): Promise<string>;
}

class PubSubAgentEventPublisher implements AgentEventPublisher {
  private client: PubSub | undefined;

  async publish(
    data: Buffer,
    attributes: Record<string, string>,
  ): Promise<string> {
    this.client ??= new PubSub({ projectId: required('PROJECT_ID') });
    return this.client
      .topic(required('AGENT_LCARS_AGENT_EVENTS_TOPIC'))
      .publishMessage({ data, attributes });
  }
}

export const defaultAgentEventPublisher: AgentEventPublisher =
  new PubSubAgentEventPublisher();

export interface AgentEventRoutingDeps {
  store: AgentEventSubscriptionStore;
  publisher: AgentEventPublisher;
  /** Records the event on a Work a dispatched run subscribed, so it resumes
   * that Work (`queueWorkEventResume`). */
  resumeWork: (request: WorkResumeRequest) => Promise<WorkResumeOutcome>;
}

export type RoutedDelivery =
  | {
      readonly subscriptionId: string;
      readonly deliveryId: string;
      readonly outcome: 'published';
      readonly host: string;
      readonly ended: boolean;
      readonly messageId: string;
    }
  | {
      readonly subscriptionId: string;
      readonly deliveryId: string;
      /** This event id was already published for the subscription. */
      readonly outcome: 'duplicate';
    }
  | {
      readonly subscriptionId: string;
      readonly deliveryId: string;
      /** A Work target: the event now waits on the Work and resumes it. */
      readonly outcome: 'resume-queued';
      readonly workId: string;
      readonly ended: boolean;
    }
  | {
      readonly subscriptionId: string;
      readonly deliveryId: string;
      /** A Work target that cannot take this event now: its waiting list is
       * full while a run holds it. This event is dropped; the subscription
       * stays. */
      readonly outcome: 'resume-dropped';
      readonly workId: string;
    }
  | {
      readonly subscriptionId: string;
      readonly deliveryId: string;
      /** A Work target that can never take the event (unknown, closed,
       * canceled, or over its event-resume limit); the subscription is
       * removed. */
      readonly outcome: 'resume-refused';
      readonly workId: string;
      readonly reason: string;
    };

/**
 * Routes one event to every subscription that matches it (#3538): one
 * Pub/Sub message per session subscription, addressed to the subscribing
 * session's host, and the subscription is removed when the event ends it.
 * A Work subscription (#3570) records the event on that Work instead, which
 * starts a resume run of it once no run holds it; a Work that can never take
 * the event loses the subscription.
 *
 * Repeating an event id is safe. A subscription remembers the event ids it
 * was published for and skips them, and one the event ended is gone. Two
 * concurrent calls for the same event may both publish; the delivery agent
 * drops the repeat by its delivery id.
 *
 * An invalid event throws before anything is read. A failed publish leaves
 * that subscription untouched and is thrown after the rest are routed, so
 * the caller retries the event and only the failed deliveries go out again.
 */
export async function routeAgentEvent(
  input: unknown,
  deps: AgentEventRoutingDeps,
): Promise<{ eventId: string; deliveries: RoutedDelivery[] }> {
  const event = agentEventSchema.parse(input);
  return routeAgentEventToSubscriptions(
    event,
    await deps.store.listForKey(event.key),
    deps,
  );
}

/**
 * {@link routeAgentEvent} for a caller that already read the key's
 * subscriptions, so a source that checks for subscribers before doing more
 * work reads them once. Only the given subscriptions that match the event
 * are routed.
 */
export async function routeAgentEventToSubscriptions(
  input: unknown,
  candidates: readonly StoredAgentEventSubscription[],
  deps: AgentEventRoutingDeps,
): Promise<{ eventId: string; deliveries: RoutedDelivery[] }> {
  const event = agentEventSchema.parse(input);
  const subscriptions = candidates
    .filter((subscription) => subscriptionMatches(subscription, event))
    .sort((a, b) => a.id.localeCompare(b.id));
  const deliveries: RoutedDelivery[] = [];
  const failures: unknown[] = [];
  for (const subscription of subscriptions) {
    const deliveryId = agentEventDeliveryId(event, subscription);
    const base = { subscriptionId: subscription.id, deliveryId };
    if (subscription.routedEventIds?.includes(event.id)) {
      deliveries.push({ ...base, outcome: 'duplicate' });
      continue;
    }
    const { target } = subscription;
    const ended = eventEndsSubscription(subscription, event);
    if (target.type === 'work') {
      try {
        deliveries.push(
          await resumeWorkTarget(deps, subscription, target.workId, {
            event,
            deliveryId,
            ended,
          }),
        );
      } catch (error) {
        failures.push(error);
      }
      continue;
    }
    const body: AgentEventDelivery = {
      deliveryId,
      subscriptionId: subscription.id,
      target,
      event,
      ended,
      notice: renderAgentEventNotice(event, subscription, ended),
    };
    try {
      const messageId = await deps.publisher.publish(
        Buffer.from(JSON.stringify(body)),
        { host: target.host, delivery_id: deliveryId },
      );
      await deps.store.settleRouted(subscription.id, event.id, ended);
      deliveries.push({
        ...base,
        outcome: 'published',
        host: target.host,
        ended,
        messageId,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      `${failures.length} of ${subscriptions.length} deliveries for event ${event.id} failed`,
    );
  return { eventId: event.id, deliveries };
}

/** Records the event on the subscribed Work and settles the subscription:
 * kept on a transient refusal, removed when the Work can never take it. */
async function resumeWorkTarget(
  deps: AgentEventRoutingDeps,
  subscription: StoredAgentEventSubscription,
  workId: string,
  input: {
    event: AgentEvent;
    deliveryId: string;
    ended: boolean;
  },
): Promise<RoutedDelivery> {
  const { event, deliveryId, ended } = input;
  const base = { subscriptionId: subscription.id, deliveryId };
  const resumed = await deps.resumeWork({
    workId,
    deliveryId,
    notice: renderAgentEventNotice(event, subscription, ended),
  });
  switch (resumed.outcome) {
    case 'refused':
      await deps.store.settleRouted(subscription.id, event.id, true);
      logger.warn(
        'agent-lcars: removed event subscription %s: work %s refused event %s (%s)',
        subscription.id,
        workId,
        event.id,
        resumed.reason,
      );
      return {
        ...base,
        outcome: 'resume-refused',
        workId,
        reason: resumed.reason,
      };
    case 'dropped':
      // Settled as routed so a redelivery is not retried, but never as
      // ended: the Work keeps waiting for its later events.
      await deps.store.settleRouted(subscription.id, event.id, false);
      logger.warn(
        'agent-lcars: work %s dropped event %s for subscription %s: too many events waiting',
        workId,
        event.id,
        subscription.id,
      );
      return { ...base, outcome: 'resume-dropped', workId };
    case 'duplicate':
      await deps.store.settleRouted(subscription.id, event.id, ended);
      return { ...base, outcome: 'duplicate' };
    case 'queued':
      await deps.store.settleRouted(subscription.id, event.id, ended);
      return { ...base, outcome: 'resume-queued', workId, ended };
  }
}
