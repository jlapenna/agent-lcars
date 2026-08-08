import 'server-only';

import crypto from 'node:crypto';

import {
  type IssueOrPullRequest,
  normalizeEvent,
} from '@agent-lcars/dispatch-controller/normalize';
import { TaskLeaseBusyError } from '@agent-lcars/dispatch-controller/storage/authority';
import type {
  ReconcileIssueQuery,
  ReconcileScanResult,
  ReconcileTransport,
} from '@agent-lcars/dispatch-reconcile';
import { runReconcileScan } from '@agent-lcars/dispatch-reconcile';
import type { Octokit } from '@octokit/rest';

import {
  agentFleetLogin,
  controlPlaneRepository,
  maintainerLogin,
} from './deployment';
import type { ReconcileOidcIdentity } from './github-actions-oidc';
import { getGithubClient } from './github-client';
import { processHostedControllerEvent } from './hosted-controller';

function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = repository.split('/');
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  return { owner, repo };
}

export function createOctokitReconcileTransport(
  octokit: Octokit,
  identity: ReconcileOidcIdentity,
  now: Date | string = new Date(),
  invocationId: string = crypto.randomUUID(),
): ReconcileTransport {
  return {
    listIssues: async (query: ReconcileIssueQuery) => {
      const { owner, repo } = splitRepository(query.repository);
      const response = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: query.state,
        per_page: query.perPage,
        page: query.page,
        ...(query.label && { labels: query.label }),
        ...(query.assignee && { assignee: query.assignee }),
        ...(query.since && { since: query.since }),
      });
      return response.data.map((issue) => ({ number: issue.number }));
    },
    dispatchReconcile: async (repository, issue) => {
      const { owner, repo } = splitRepository(repository);
      if (repository !== identity.repository) {
        throw new Error(
          'Reconcile repository does not match the signed scheduler identity',
        );
      }
      const liveIssue = (
        await octokit.rest.issues.get({
          owner,
          repo,
          issue_number: issue,
        })
      ).data as IssueOrPullRequest;
      const normalized = normalizeEvent({
        eventName: 'workflow_dispatch',
        event: { action: '', issue: liveIssue },
        inputs: { kind: 'reconcile' },
        context: {
          repository,
          repositoryId: identity.repositoryId,
          issue,
          runId: identity.runId,
          now: new Date(now).toISOString(),
        },
        maintainer: maintainerLogin(),
      });
      try {
        await processHostedControllerEvent({
          normalized,
          isPullRequest: Boolean(liveIssue.pull_request),
          transportRunId: identity.runId,
          authorityOwner: `reconcile:${identity.runId}:${issue}:${invocationId}`,
          // A scheduled scan can discover an unbounded number of candidates.
          // Defer contended issues to the next pass instead of accumulating a
          // 130-second lease wait for every five-candidate wave.
          authorityBusyWaitMs: 0,
        });
      } catch (error) {
        if (error instanceof TaskLeaseBusyError) {
          console.info(
            `agent-lcars: deferred hosted reconciliation for ` +
              `${repository}#${issue} because its authority lease is busy`,
          );
          return;
        }
        throw error;
      }
    },
  };
}

export function runHostedReconcile(
  identity: ReconcileOidcIdentity,
  octokit: Octokit = getGithubClient(),
  repository: string = controlPlaneRepository(),
  fleetLogin: string = agentFleetLogin(),
  now: Date | string = new Date(),
): Promise<ReconcileScanResult> {
  return runReconcileScan(
    createOctokitReconcileTransport(octokit, identity, now),
    repository,
    fleetLogin,
    now,
  );
}
