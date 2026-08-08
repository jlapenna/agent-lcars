import 'server-only';

import {
  isWebhookIngressCanaryAction,
  WEBHOOK_INGRESS_CANARY_MARKER,
  WEBHOOK_INGRESS_CANARY_TITLE,
  type WebhookIngressCanaryAction,
} from '@agent-lcars/dispatch-contracts';
import { required } from '@agent-lcars/util-server';
import { Firestore } from '@google-cloud/firestore';

import { assertGitHubDeliveryId } from './github-webhook-auth';
import type { GitHubWebhookPayload } from './hosted-admission';

const RECEIPTS_COLLECTION = 'webhookIngressCanaryReceipts';

export interface WebhookIngressCanaryIdentity {
  deliveryId: string;
  eventName: 'issues';
  action: WebhookIngressCanaryAction;
  repository: string;
  repositoryId: number;
  issue: number;
}

export interface WebhookIngressReceipt extends WebhookIngressCanaryIdentity {
  receivedAt: string;
  enqueuedAt?: string;
  enqueueOutcome?: 'enqueued' | 'duplicate';
  processorAttempt?: number;
  processorStartedAt?: string;
  processedAt?: string;
  lastProcessorFailure?: {
    attempt: number;
    occurredAt: string;
    message: string;
  };
}

export type WebhookIngressReceiptPatch = Partial<WebhookIngressReceipt> &
  Pick<WebhookIngressReceipt, 'deliveryId'>;

export interface WebhookIngressReceiptPort {
  merge(patch: WebhookIngressReceiptPatch): Promise<void>;
  read(deliveryId: string): Promise<WebhookIngressReceipt | undefined>;
}

class FirestoreWebhookIngressReceiptPort implements WebhookIngressReceiptPort {
  readonly #collection;

  constructor() {
    const firestore = new Firestore({
      projectId: required('PROJECT_ID'),
      databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
      ignoreUndefinedProperties: true,
    });
    this.#collection = firestore.collection(RECEIPTS_COLLECTION);
  }

  async merge(patch: WebhookIngressReceiptPatch): Promise<void> {
    await this.#collection.doc(patch.deliveryId).set(patch, { merge: true });
  }

  async read(deliveryId: string): Promise<WebhookIngressReceipt | undefined> {
    const snapshot = await this.#collection.doc(deliveryId).get();
    return snapshot.exists
      ? (snapshot.data() as WebhookIngressReceipt)
      : undefined;
  }
}

let defaultPort: WebhookIngressReceiptPort | undefined;

function receiptPort(): WebhookIngressReceiptPort {
  defaultPort ??= new FirestoreWebhookIngressReceiptPort();
  return defaultPort;
}

export function identifyWebhookIngressCanary(
  deliveryId: string,
  eventName: string,
  payload: GitHubWebhookPayload,
): WebhookIngressCanaryIdentity | undefined {
  if (
    eventName !== 'issues' ||
    !isWebhookIngressCanaryAction(payload.action) ||
    payload.issue?.title !== WEBHOOK_INGRESS_CANARY_TITLE ||
    !payload.issue.body?.includes(WEBHOOK_INGRESS_CANARY_MARKER)
  ) {
    return undefined;
  }
  assertGitHubDeliveryId(deliveryId);
  const repository = payload.repository?.full_name;
  const repositoryId = payload.repository?.id;
  const issue = payload.issue?.number;
  if (
    !repository ||
    !Number.isSafeInteger(repositoryId) ||
    Number(repositoryId) <= 0 ||
    typeof issue !== 'number' ||
    !Number.isSafeInteger(issue) ||
    issue <= 0
  ) {
    throw new Error('Webhook ingress canary payload identity is invalid');
  }
  return {
    deliveryId,
    eventName,
    action: payload.action,
    repository,
    repositoryId: Number(repositoryId),
    issue,
  };
}

export function parseCloudTasksAttempt(retryCount: string | null): number {
  if (retryCount === null) return 1;
  if (!/^\d+$/u.test(retryCount)) {
    throw new Error('Cloud Tasks retry count is invalid');
  }
  const parsed = Number(retryCount);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('Cloud Tasks retry count exceeds the safe integer range');
  }
  return parsed + 1;
}

export async function recordWebhookIngressReceived(
  identity: WebhookIngressCanaryIdentity,
  port: WebhookIngressReceiptPort = receiptPort(),
  now = new Date().toISOString(),
): Promise<void> {
  await port.merge({ ...identity, receivedAt: now });
}

export async function recordWebhookIngressEnqueued(
  identity: WebhookIngressCanaryIdentity,
  outcome: 'enqueued' | 'duplicate',
  port: WebhookIngressReceiptPort = receiptPort(),
  now = new Date().toISOString(),
): Promise<void> {
  await port.merge({
    deliveryId: identity.deliveryId,
    enqueuedAt: now,
    enqueueOutcome: outcome,
  });
}

export async function recordWebhookIngressProcessing(
  identity: WebhookIngressCanaryIdentity,
  attempt: number,
  port: WebhookIngressReceiptPort = receiptPort(),
  now = new Date().toISOString(),
): Promise<void> {
  await port.merge({
    deliveryId: identity.deliveryId,
    processorAttempt: attempt,
    processorStartedAt: now,
  });
}

export async function recordWebhookIngressProcessed(
  identity: WebhookIngressCanaryIdentity,
  port: WebhookIngressReceiptPort = receiptPort(),
  now = new Date().toISOString(),
): Promise<void> {
  await port.merge({ deliveryId: identity.deliveryId, processedAt: now });
}

export async function recordWebhookIngressProcessorFailure(
  identity: WebhookIngressCanaryIdentity,
  attempt: number,
  error: unknown,
  port: WebhookIngressReceiptPort = receiptPort(),
  now = new Date().toISOString(),
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await port.merge({
    deliveryId: identity.deliveryId,
    lastProcessorFailure: {
      attempt,
      occurredAt: now,
      message: message.slice(0, 500),
    },
  });
}

export function readWebhookIngressReceipt(
  deliveryId: string,
  port: WebhookIngressReceiptPort = receiptPort(),
): Promise<WebhookIngressReceipt | undefined> {
  assertGitHubDeliveryId(deliveryId);
  return port.read(deliveryId);
}
