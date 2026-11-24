import 'server-only';

import { required } from '@agent-lcars/util-server';
import { PubSub } from '@google-cloud/pubsub';

/** GitHub Actions webhook events forwarded to the Homelab GitHub Actions
 * exporter (#3525). They create no LCARS work, so they skip the Cloud Tasks
 * admission queue and go straight to Pub/Sub, which the exporter reads with a
 * streaming-pull subscription in place of polling GitHub's REST API. */
export const GITHUB_ACTIONS_EVENTS: ReadonlySet<string> = new Set([
  'workflow_job',
  'workflow_run',
]);

export interface ActionsEventDelivery {
  rawBody: Buffer;
  deliveryId: string;
  eventName: string;
  repository: string;
}

export interface ActionsEventPublisher {
  publish(data: Buffer, attributes: Record<string, string>): Promise<string>;
}

class PubSubActionsEventPublisher implements ActionsEventPublisher {
  private client: PubSub | undefined;

  async publish(
    data: Buffer,
    attributes: Record<string, string>,
  ): Promise<string> {
    this.client ??= new PubSub({ projectId: required('PROJECT_ID') });
    return this.client
      .topic(required('AGENT_LCARS_ACTIONS_EVENTS_TOPIC'))
      .publishMessage({ data, attributes });
  }
}

export const defaultActionsEventPublisher: ActionsEventPublisher =
  new PubSubActionsEventPublisher();

/** Publishes the signed delivery's raw body. A failure propagates so the
 * route answers 5xx and GitHub records a failed delivery that can be
 * redelivered from the App's delivery log. */
export async function publishActionsEvent(
  delivery: ActionsEventDelivery,
  publisher: ActionsEventPublisher = defaultActionsEventPublisher,
): Promise<{ deliveryId: string; outcome: 'published'; messageId: string }> {
  const messageId = await publisher.publish(delivery.rawBody, {
    event: delivery.eventName,
    delivery_id: delivery.deliveryId,
    repository: delivery.repository,
  });
  return { deliveryId: delivery.deliveryId, outcome: 'published', messageId };
}
