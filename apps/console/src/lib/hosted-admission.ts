import 'server-only';

import crypto from 'node:crypto';

import {
  normalizeEvent,
  type TimelineEvent,
  type WebhookEvent,
} from '@agent-lcars/dispatch-controller/normalize';
import { optional } from '@agent-lcars/util-server';

import { controlPlaneRepository, maintainerLogin } from './deployment';
import { getGithubClient } from './github-client';
import { assertGitHubDeliveryId } from './github-webhook-auth';
import { processHostedControllerEvent } from './hosted-controller';

const SUPPORTED_EVENTS = new Set(['issues', 'issue_comment', 'pull_request']);

export type HostedAdmissionMode = 'authority';

interface RepositoryPayload {
  id?: number;
  full_name?: string;
}

export interface GitHubWebhookPayload extends WebhookEvent {
  repository?: RepositoryPayload;
}

export interface HostedAdmissionResult {
  deliveryId: string;
  eventName: string;
  mode: HostedAdmissionMode;
  outcome: 'ignored' | 'processed';
  reason?: string;
}

function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = repository.split('/');
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  return { owner, repo };
}

export function parseHostedAdmissionMode(
  value: string | undefined,
): HostedAdmissionMode {
  const mode = value?.trim();
  if (mode !== 'authority') {
    throw new Error(
      `AGENT_LCARS_HOSTED_ADMISSION_MODE must be 'authority'; ` +
        `off, shadow, and unset configuration were retired after the Firestore authority cutover`,
    );
  }
  return mode;
}

/**
 * `transportRunId` predates hosted delivery and remains a JSON number in the
 * live ledger schema. Fold GitHub's globally unique delivery UUID into the
 * positive 48-bit integer range so webhook redelivery keeps exactly the same
 * transport identity without exceeding JavaScript's safe integer limit.
 */
export function deliveryTransportId(deliveryId: string): number {
  const bytes = crypto.createHash('sha256').update(deliveryId).digest();
  const value = bytes.readUIntBE(0, 6);
  return value === 0 ? 1 : value;
}

function needsTimeline(eventName: string, action: string): boolean {
  return (
    (eventName === 'issues' &&
      ['labeled', 'unlabeled', 'closed', 'reopened'].includes(action)) ||
    (eventName === 'pull_request' && ['labeled', 'unlabeled'].includes(action))
  );
}

export async function loadTimeline(
  eventName: string,
  payload: GitHubWebhookPayload,
): Promise<TimelineEvent[]> {
  if (!needsTimeline(eventName, payload.action)) return [];
  const numbered = payload.issue ?? payload.pull_request;
  if (!numbered?.number) {
    throw new Error(
      `${eventName}:${payload.action} webhook is missing an issue number`,
    );
  }
  const repository = payload.repository?.full_name;
  if (!repository) throw new Error('Webhook is missing repository.full_name');
  const { owner, repo } = splitRepository(repository);
  const client = getGithubClient();
  return (await client.paginate(client.rest.issues.listEventsForTimeline, {
    owner,
    repo,
    issue_number: numbered.number,
    per_page: 100,
  })) as TimelineEvent[];
}

export async function admitGitHubWebhook({
  deliveryId,
  eventName,
  payload,
  mode = parseHostedAdmissionMode(
    optional('AGENT_LCARS_HOSTED_ADMISSION_MODE'),
  ),
}: {
  deliveryId: string;
  eventName: string;
  payload: GitHubWebhookPayload;
  mode?: HostedAdmissionMode;
}): Promise<HostedAdmissionResult> {
  assertGitHubDeliveryId(deliveryId);
  if (!eventName) throw new Error('GitHub webhook event name is missing');
  if (eventName === 'ping') {
    return { deliveryId, eventName, mode, outcome: 'ignored', reason: 'ping' };
  }
  if (!SUPPORTED_EVENTS.has(eventName)) {
    throw new Error(`Unsupported GitHub webhook event: ${eventName}`);
  }

  const expectedRepository = controlPlaneRepository();
  if (payload.repository?.full_name !== expectedRepository) {
    throw new Error('Webhook repository is outside the control-plane boundary');
  }
  const repositoryId = payload.repository.id;
  if (!Number.isSafeInteger(repositoryId) || Number(repositoryId) <= 0) {
    throw new Error('Webhook repository ID is invalid');
  }
  const transportRunId = deliveryTransportId(deliveryId);
  const normalized = normalizeEvent({
    eventName,
    event: payload,
    context: {
      repository: expectedRepository,
      repositoryId: Number(repositoryId),
      runId: transportRunId,
      actor: payload.sender?.login,
      now: new Date().toISOString(),
    },
    timeline: await loadTimeline(eventName, payload),
    maintainer: maintainerLogin(),
  });
  if (normalized.kind === 'ignored') {
    return {
      deliveryId,
      eventName,
      mode,
      outcome: 'ignored',
      reason: normalized.reason,
    };
  }

  await processHostedControllerEvent({
    normalized,
    isPullRequest: Boolean(payload.pull_request ?? payload.issue?.pull_request),
    transportRunId,
    authorityOwner: `webhook:${deliveryId}`,
  });

  return { deliveryId, eventName, mode, outcome: 'processed' };
}
