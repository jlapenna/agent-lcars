import 'server-only';

import { required } from '@agent-lcars/util-server';
import {
  type AgentEventDelivery,
  agentEventDeliveryId,
  agentEventSchema,
  eventEndsSubscription,
  renderAgentEventNotice,
  subscriptionMatches,
} from '@agent-lcars/work';
import { PubSub } from '@google-cloud/pubsub';

import {
  type AgentEventSubscriptionStore,
  agentEventSubscriptionStore,
} from './agent-event-store';

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
      /** A Work target, which this router cannot deliver to yet (#3570). */
      readonly outcome: 'unsupported-target';
    };

/**
 * Routes one event to every subscription that matches it (#3538): one
 * Pub/Sub message per subscription, addressed to the subscribing session's
 * host, and the subscription is removed when the event ends it.
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
  deps: AgentEventRoutingDeps = {
    store: agentEventSubscriptionStore,
    publisher: defaultAgentEventPublisher,
  },
): Promise<{ eventId: string; deliveries: RoutedDelivery[] }> {
  const event = agentEventSchema.parse(input);
  const subscriptions = (await deps.store.listForKey(event.key))
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
    if (target.type !== 'session') {
      deliveries.push({ ...base, outcome: 'unsupported-target' });
      continue;
    }
    const ended = eventEndsSubscription(subscription, event);
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
