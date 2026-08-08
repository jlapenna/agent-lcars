import 'server-only';

import crypto from 'node:crypto';

import { CompletionBindingError } from '@agent-lcars/dispatch-controller/main';
import {
  type IssueOrPullRequest,
  normalizeEvent,
} from '@agent-lcars/dispatch-controller/normalize';
import type { Octokit } from '@octokit/rest';

import { controlPlaneRepository, maintainerLogin } from './deployment';
import type { CompletionOidcIdentity } from './github-actions-oidc';
import { getGithubClient } from './github-client';
import { processHostedControllerEvent } from './hosted-controller';

interface HostedCompletionBody {
  issue: number;
  generation?: unknown;
  intentId?: unknown;
  token?: unknown;
  workflow: string;
  outcome?: unknown;
  outcomeReference?: unknown;
  readinessFailure?: unknown;
}

export class HostedCompletionInputError extends Error {}

function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = repository.split('/');
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  return { owner, repo };
}

function parseBody(body: unknown): HostedCompletionBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HostedCompletionInputError('Completion body must be an object');
  }
  const candidate = body as Record<string, unknown>;
  const issue = candidate['issue'];
  if (typeof issue !== 'number' || !Number.isSafeInteger(issue) || issue <= 0) {
    throw new HostedCompletionInputError(
      'Completion issue must be a positive safe integer',
    );
  }
  if (typeof candidate['workflow'] !== 'string') {
    throw new HostedCompletionInputError('Completion workflow is required');
  }
  return {
    issue,
    generation: candidate['generation'],
    intentId: candidate['intentId'],
    token: candidate['token'],
    workflow: candidate['workflow'],
    outcome: candidate['outcome'],
    outcomeReference: candidate['outcomeReference'],
    readinessFailure: candidate['readinessFailure'],
  };
}

export async function completeHostedWorker({
  identity,
  body,
  octokit = getGithubClient(),
  now = new Date(),
  invocationId = crypto.randomUUID(),
}: {
  identity: CompletionOidcIdentity;
  body: unknown;
  octokit?: Octokit;
  now?: Date | string;
  invocationId?: string;
}): Promise<{ issue: number; workerRunId: number; workflow: string }> {
  const completion = parseBody(body);
  const expectedRepository = controlPlaneRepository();
  if (identity.repository !== expectedRepository) {
    throw new HostedCompletionInputError(
      'Completion repository does not match the control plane',
    );
  }
  if (completion.workflow !== identity.workflow) {
    throw new HostedCompletionInputError(
      'Completion workflow does not match the signed worker identity',
    );
  }

  const { owner, repo } = splitRepository(identity.repository);
  const issue = (
    await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: completion.issue,
    })
  ).data as IssueOrPullRequest;

  let normalized;
  try {
    normalized = normalizeEvent({
      eventName: 'workflow_dispatch',
      event: { action: '', issue },
      inputs: {
        kind: 'completion',
        completion_payload: Buffer.from(
          JSON.stringify({
            workerRunId: identity.runId,
            generation: completion.generation,
            intentId: completion.intentId,
            token: completion.token,
            workflow: identity.workflow,
            outcome: completion.outcome,
            outcomeReference: completion.outcomeReference,
            readinessFailure: completion.readinessFailure,
          }),
        ).toString('base64url'),
      },
      context: {
        repository: identity.repository,
        repositoryId: identity.repositoryId,
        issue: completion.issue,
        runId: identity.runId,
        now: new Date(now).toISOString(),
      },
      maintainer: maintainerLogin(),
    });
  } catch (error) {
    throw new HostedCompletionInputError(
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    await processHostedControllerEvent({
      normalized,
      isPullRequest: Boolean(issue.pull_request),
      transportRunId: identity.runId,
      authorityOwner: `completion:${identity.runId}:${invocationId}`,
      pollCompletionUntilTerminal: false,
    });
  } catch (error) {
    if (error instanceof CompletionBindingError) {
      throw new HostedCompletionInputError(error.message);
    }
    throw error;
  }
  return {
    issue: completion.issue,
    workerRunId: identity.runId,
    workflow: identity.workflow,
  };
}
