import 'server-only';

import crypto from 'node:crypto';

import {
  type IssueOrPullRequest,
  normalizeEvent,
} from '@agent-lcars/dispatch-controller/normalize';
import { required } from '@agent-lcars/util-server';
import type { Octokit } from '@octokit/rest';

import { controlPlaneRepository, maintainerLogin } from './deployment';
import { getGithubClient } from './github-client';
import { processHostedControllerEvent } from './hosted-controller';
import {
  defaultWebhookTaskQueue,
  type WebhookTaskQueue,
} from './hosted-webhook-queue';

const RETRY_DELAY_SECONDS = 5;

export interface CompletionReconcilePayload {
  repository: string;
  repositoryId: number;
  issue: number;
  workerRunId: number;
}

export class CompletionRunNotTerminalError extends Error {}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = repository.split('/');
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  return { owner, repo };
}

export function parseCompletionReconcilePayload(
  value: unknown,
): CompletionReconcilePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Completion reconciliation payload must be an object');
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['repository'] !== 'string') {
    throw new Error('Completion reconciliation repository is required');
  }
  splitRepository(candidate['repository']);
  return {
    repository: candidate['repository'],
    repositoryId: positiveInteger(candidate['repositoryId'], 'repositoryId'),
    issue: positiveInteger(candidate['issue'], 'issue'),
    workerRunId: positiveInteger(candidate['workerRunId'], 'workerRunId'),
  };
}

function signature(body: Buffer, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 6
  );
}

/**
 * Queue one exact post-run reconciliation. The named task makes a retried
 * completion callback idempotent; Cloud Tasks retries the processor until
 * GitHub reports the source worker run terminal.
 */
export async function enqueueCompletionReconcile(
  payloadInput: CompletionReconcilePayload,
  queue: WebhookTaskQueue = defaultWebhookTaskQueue,
  {
    now = new Date(),
    baseUrl = required('AUTH_URL'),
    secret = required('AGENT_LCARS_WEBHOOK_SECRET'),
  }: { now?: Date | string; baseUrl?: string; secret?: string } = {},
): Promise<'enqueued' | 'duplicate'> {
  const payload = parseCompletionReconcilePayload(payloadInput);
  const body = Buffer.from(JSON.stringify(payload));
  try {
    await queue.enqueue({
      taskId: `completion-reconcile-${payload.workerRunId}-${payload.issue}`,
      url: `${baseUrl.replace(/\/$/u, '')}/api/control-plane/completion/reconcile`,
      headers: {
        'content-type': 'application/json',
        'x-agent-lcars-signature-256': signature(body, secret),
      },
      body,
      scheduleTime: {
        seconds:
          Math.floor(new Date(now).getTime() / 1000) + RETRY_DELAY_SECONDS,
      },
    });
    return 'enqueued';
  } catch (error) {
    if (isAlreadyExists(error)) return 'duplicate';
    throw error;
  }
}

/** Run one exact reconciliation only after the callback's source run ends. */
export async function reconcileCompletedWorker(
  payloadInput: unknown,
  octokit: Octokit = getGithubClient(),
  now: Date | string = new Date(),
  invocationId: string = crypto.randomUUID(),
): Promise<{ issue: number; workerRunId: number }> {
  const payload = parseCompletionReconcilePayload(payloadInput);
  if (payload.repository !== controlPlaneRepository()) {
    throw new Error(
      'Completion reconciliation repository does not match the control plane',
    );
  }
  const { owner, repo } = splitRepository(payload.repository);
  const worker = await octokit.rest.actions.getWorkflowRun({
    owner,
    repo,
    run_id: payload.workerRunId,
  });
  if (worker.data.status !== 'completed') {
    throw new CompletionRunNotTerminalError(
      `Worker run ${payload.workerRunId} is not terminal`,
    );
  }
  const issue = (
    await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: payload.issue,
    })
  ).data as IssueOrPullRequest;
  const normalized = normalizeEvent({
    eventName: 'workflow_dispatch',
    event: { action: '', issue },
    inputs: { kind: 'reconcile' },
    context: {
      repository: payload.repository,
      repositoryId: payload.repositoryId,
      issue: payload.issue,
      runId: payload.workerRunId,
      now: new Date(now).toISOString(),
    },
    maintainer: maintainerLogin(),
  });
  await processHostedControllerEvent({
    normalized,
    isPullRequest: Boolean(issue.pull_request),
    transportRunId: payload.workerRunId,
    authorityOwner: `completion-reconcile:${payload.workerRunId}:${invocationId}`,
  });
  return { issue: payload.issue, workerRunId: payload.workerRunId };
}
