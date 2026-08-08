import 'server-only';

import { required } from '@agent-lcars/util-server';
import { CloudTasksClient } from '@google-cloud/tasks';

import { assertGitHubDeliveryId } from './github-webhook-auth';

export interface GitHubWebhookEnvelope {
  rawBody: Buffer;
  deliveryId: string;
  eventName: string;
  signature: string;
}

export interface WebhookTask {
  taskId: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  scheduleTime?: { seconds: number };
}

export interface WebhookTaskQueue {
  enqueue(task: WebhookTask): Promise<void>;
}

class GoogleCloudTasksWebhookQueue implements WebhookTaskQueue {
  constructor(private readonly client = new CloudTasksClient()) {}

  async enqueue(task: WebhookTask): Promise<void> {
    const project = required('PROJECT_ID');
    const location = required('AGENT_LCARS_WEBHOOK_QUEUE_LOCATION');
    const queue = required('AGENT_LCARS_WEBHOOK_QUEUE');
    const parent = this.client.queuePath(project, location, queue);

    await this.client.createTask({
      parent,
      task: {
        name: this.client.taskPath(project, location, queue, task.taskId),
        httpRequest: {
          url: task.url,
          httpMethod: 'POST',
          headers: task.headers,
          body: task.body,
        },
        ...(task.scheduleTime && { scheduleTime: task.scheduleTime }),
        // Firestore authority deliberately waits for a contested lease before
        // retrying. Give that bounded wait room to finish in the worker, while
        // the public GitHub endpoint only waits for this durable enqueue.
        dispatchDeadline: { seconds: 300 },
      },
    });
  }
}

export const defaultWebhookTaskQueue = new GoogleCloudTasksWebhookQueue();

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 6
  );
}

export async function enqueueGitHubWebhook(
  envelope: GitHubWebhookEnvelope,
  queue: WebhookTaskQueue = defaultWebhookTaskQueue,
): Promise<{
  deliveryId: string;
  eventName: string;
  outcome: 'enqueued' | 'duplicate';
}> {
  assertGitHubDeliveryId(envelope.deliveryId);
  if (!envelope.eventName.trim()) {
    throw new Error('GitHub webhook event name is missing');
  }

  const target = `${required('AUTH_URL').replace(/\/$/u, '')}/api/control-plane/webhook/process`;
  try {
    await queue.enqueue({
      taskId: `github-${envelope.deliveryId.toLowerCase()}`,
      url: target,
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': envelope.deliveryId,
        'x-github-event': envelope.eventName,
        'x-hub-signature-256': envelope.signature,
      },
      body: envelope.rawBody,
    });
    return {
      deliveryId: envelope.deliveryId,
      eventName: envelope.eventName,
      outcome: 'enqueued',
    };
  } catch (error) {
    // A named task makes GitHub redelivery idempotent at the durable boundary.
    // Cloud Tasks reports an existing name as gRPC ALREADY_EXISTS (code 6).
    if (isAlreadyExists(error)) {
      return {
        deliveryId: envelope.deliveryId,
        eventName: envelope.eventName,
        outcome: 'duplicate',
      };
    }
    throw error;
  }
}
