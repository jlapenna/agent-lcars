import 'server-only';

import {
  isWebhookIngressCanaryAction,
  type WebhookIngressCanaryAction,
} from '@agent-lcars/dispatch-contracts';
import { FirestoreStoragePort } from '@agent-lcars/dispatch-controller/storage/firestore-port';
import type { StoragePort } from '@agent-lcars/dispatch-controller/storage/port';
import { required } from '@agent-lcars/util-server';

import type { WebhookIngressCanaryOidcIdentity } from './github-actions-oidc';
import { assertGitHubDeliveryId } from './github-webhook-auth';
import { deliveryTransportId } from './hosted-admission';
import {
  readWebhookIngressReceipt,
  type WebhookIngressReceipt,
} from './webhook-ingress-receipt';

export interface WebhookIngressProbeRequest {
  deliveryId: string;
  issue: number;
  action: WebhookIngressCanaryAction;
  sourceId: string;
}

export type WebhookIngressProbeStage =
  | 'awaiting-receipt'
  | 'received'
  | 'enqueued'
  | 'processing'
  | 'processor-failed'
  | 'repeated-processor-failure'
  | 'missing-durable-observation'
  | 'success';

export interface WebhookIngressProbeResult {
  stage: WebhookIngressProbeStage;
  deliveryId: string;
  issue: number;
  action: WebhookIngressCanaryAction;
  sourceId: string;
  processorAttempt?: number;
  controllerRevision?: number;
}

function validateRequest(request: WebhookIngressProbeRequest): void {
  assertGitHubDeliveryId(request.deliveryId);
  if (!Number.isSafeInteger(request.issue) || request.issue <= 0) {
    throw new Error('Webhook ingress probe issue is invalid');
  }
  if (!isWebhookIngressCanaryAction(request.action)) {
    throw new Error('Webhook ingress probe action is invalid');
  }
  if (!/^timeline:[1-9]\d*$/u.test(request.sourceId)) {
    throw new Error('Webhook ingress probe source ID is invalid');
  }
}

function assertReceiptIdentity(
  receipt: WebhookIngressReceipt,
  identity: WebhookIngressCanaryOidcIdentity,
  request: WebhookIngressProbeRequest,
): void {
  if (
    receipt.deliveryId !== request.deliveryId ||
    receipt.eventName !== 'issues' ||
    receipt.repository !== identity.repository ||
    receipt.repositoryId !== identity.repositoryId ||
    receipt.issue !== request.issue ||
    receipt.action !== request.action
  ) {
    throw new Error('Webhook ingress receipt identity does not match request');
  }
}

function receiptStage(
  receipt: WebhookIngressReceipt,
): WebhookIngressProbeStage {
  if (receipt.processedAt) return 'missing-durable-observation';
  if (
    receipt.lastProcessorFailure &&
    receipt.lastProcessorFailure.attempt >= (receipt.processorAttempt ?? 0)
  ) {
    return receipt.lastProcessorFailure.attempt >= 2
      ? 'repeated-processor-failure'
      : 'processor-failed';
  }
  if (receipt.processorStartedAt) return 'processing';
  if (receipt.enqueuedAt) return 'enqueued';
  return 'received';
}

export async function inspectWebhookIngressProbe({
  identity,
  request,
  readReceipt = readWebhookIngressReceipt,
  storagePort = new FirestoreStoragePort({
    projectId: required('PROJECT_ID'),
    databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
  }),
}: {
  identity: WebhookIngressCanaryOidcIdentity;
  request: WebhookIngressProbeRequest;
  readReceipt?: (
    deliveryId: string,
  ) => Promise<WebhookIngressReceipt | undefined>;
  storagePort?: Pick<StoragePort, 'readTask'>;
}): Promise<WebhookIngressProbeResult> {
  validateRequest(request);
  const base = {
    deliveryId: request.deliveryId,
    issue: request.issue,
    action: request.action,
    sourceId: request.sourceId,
  };
  const receipt = await readReceipt(request.deliveryId);
  if (!receipt) return { ...base, stage: 'awaiting-receipt' };
  assertReceiptIdentity(receipt, identity, request);

  const stored = await storagePort.readTask({
    repository: identity.repository,
    repositoryId: identity.repositoryId,
    issue: request.issue,
  });
  const ledger = stored?.controllerState;
  const expectedTransportId = deliveryTransportId(request.deliveryId);
  const exactSource = ledger?.sources.some(
    (source) =>
      source.sourceKind === request.action &&
      source.sourceId === request.sourceId &&
      source.transportRunId === expectedTransportId,
  );
  const exactControl = Boolean(
    ledger &&
    ledger.control.sourceId === request.sourceId &&
    ledger.control.closed === (request.action === 'closed'),
  );
  if (receipt.processedAt && exactSource && exactControl) {
    return {
      ...base,
      stage: 'success',
      processorAttempt: receipt.processorAttempt,
      controllerRevision: stored?.revision,
    };
  }
  return {
    ...base,
    stage: receiptStage(receipt),
    processorAttempt: receipt.processorAttempt,
    controllerRevision: stored?.revision,
  };
}
