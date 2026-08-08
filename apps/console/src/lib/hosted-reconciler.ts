import 'server-only';

import type {
  ReconcileIssueQuery,
  ReconcileScanResult,
  ReconcileTransport,
} from '@agent-lcars/dispatch-reconcile';
import { runReconcileScan } from '@agent-lcars/dispatch-reconcile';
import type { Octokit } from '@octokit/rest';

import { agentFleetLogin, controlPlaneRepository } from './deployment';
import { getGithubClient } from './github-client';

function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo, ...rest] = repository.split('/');
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  return { owner, repo };
}

export function createOctokitReconcileTransport(
  octokit: Octokit,
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
      await octokit.rest.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: 'agent-router.yml',
        ref: 'main',
        inputs: { kind: 'reconcile', issue: String(issue) },
      });
    },
  };
}

export function runHostedReconcile(
  octokit: Octokit = getGithubClient(),
  repository: string = controlPlaneRepository(),
  fleetLogin: string = agentFleetLogin(),
  now: Date | string = new Date(),
): Promise<ReconcileScanResult> {
  return runReconcileScan(
    createOctokitReconcileTransport(octokit),
    repository,
    fleetLogin,
    now,
  );
}
