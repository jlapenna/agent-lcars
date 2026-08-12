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

/**
 * Thrown for admission failures that are deterministic given the delivered
 * payload -- a malformed/unsupported webhook, a normalization rule that
 * rejects this exact event every time. Retrying buys nothing, so the route
 * handler acks these immediately instead of letting Cloud Tasks hammer the
 * same poisoned delivery forever (agent-lcars#958). Contrast with an
 * unwrapped `Error` (Firestore contention, GitHub API outage, lease
 * conflicts), which stays on the retryable 5xx path.
 */
export class PermanentAdmissionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentAdmissionError';
  }
}

function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = repository.split('/');
  if (!owner || !repo || rest.length > 0) {
    throw new PermanentAdmissionError(
      `Invalid GitHub repository: ${repository}`,
    );
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
    throw new PermanentAdmissionError(
      `${eventName}:${payload.action} webhook is missing an issue number`,
    );
  }
  const repository = payload.repository?.full_name;
  if (!repository) {
    throw new PermanentAdmissionError(
      'Webhook is missing repository.full_name',
    );
  }
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
  try {
    assertGitHubDeliveryId(deliveryId);
  } catch (error) {
    throw new PermanentAdmissionError(
      `GitHub webhook delivery ID is invalid: ${deliveryId}`,
      { cause: error },
    );
  }
  if (!eventName) {
    throw new PermanentAdmissionError('GitHub webhook event name is missing');
  }
  if (eventName === 'ping') {
    return { deliveryId, eventName, mode, outcome: 'ignored', reason: 'ping' };
  }
  if (!SUPPORTED_EVENTS.has(eventName)) {
    throw new PermanentAdmissionError(
      `Unsupported GitHub webhook event: ${eventName}`,
    );
  }

  const expectedRepository = controlPlaneRepository();
  if (payload.repository?.full_name !== expectedRepository) {
    throw new PermanentAdmissionError(
      'Webhook repository is outside the control-plane boundary',
    );
  }
  const repositoryId = payload.repository.id;
  if (!Number.isSafeInteger(repositoryId) || Number(repositoryId) <= 0) {
    throw new PermanentAdmissionError('Webhook repository ID is invalid');
  }
  const transportRunId = deliveryTransportId(deliveryId);
  // loadTimeline's own validation throws PermanentAdmissionError directly;
  // its GitHub API call stays an unwrapped Error (transient, retryable).
  const timeline = await loadTimeline(eventName, payload);
  let normalized;
  try {
    normalized = normalizeEvent({
      eventName,
      event: payload,
      context: {
        repository: expectedRepository,
        repositoryId: Number(repositoryId),
        runId: transportRunId,
        actor: payload.sender?.login,
        now: new Date().toISOString(),
        deliveryId,
      },
      timeline,
      maintainer: maintainerLogin(),
    });
  } catch (error) {
    if (error instanceof PermanentAdmissionError) throw error;
    // normalizeEvent() is a pure function of its arguments -- no I/O -- so
    // any exception it raises is deterministic given this exact
    // payload/timeline and will throw identically on every retry. That
    // "identical every retry" property does depend on `timeline` itself
    // never being the deciding factor in whether normalizeEvent throws:
    // before agent-lcars#960, an eventually-consistent GitHub timeline
    // (re-fetched fresh on every attempt, see `loadTimeline` above) could
    // make `timelineSource()` throw on one attempt and succeed on the
    // next -- genuinely non-deterministic given the payload, and wrapping
    // it here would have been wrong (flagged in review on #962). #960
    // closed that gap: `timelineSource()` now falls back to a
    // delivery-derived sourceId whenever a deliveryId is available, and
    // `deliveryId` is required and validated above before this call is
    // ever reached, so its remaining throw (`normalize.ts`'s
    // `if (deliveryId) return {...}`) is unreachable from here. Every
    // other exception normalizeEvent can raise for the event kinds this
    // route admits (issues/issue_comment/pull_request) depends only on
    // fields GitHub embedded directly in the webhook payload -- labels,
    // comment body, sender, PR metadata -- never on state re-fetched
    // between retries, so the "deterministic given the payload" premise
    // holds for what's actually reachable today.
    throw new PermanentAdmissionError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
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
