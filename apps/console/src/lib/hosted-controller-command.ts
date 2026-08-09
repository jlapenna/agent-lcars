import 'server-only';

import { createHash } from 'node:crypto';

import {
  type IssueOrPullRequest,
  normalizeEvent,
} from '@agent-lcars/dispatch-controller/normalize';

import { maintainerLogin } from './deployment';
import { getGithubClient } from './github-client';
import { processHostedControllerEvent } from './hosted-controller';
import type { AgentPipeline, RepositoryRef } from './watched-repo';
import { repoKey } from './watched-repo';

interface HostedCommandBase {
  repository: RepositoryRef;
  issueNumber: number;
  /** Stable UUID supplied by the authenticated console action. */
  requestId: string;
}

export type HostedControllerCommand =
  | (HostedCommandBase & { kind: 'reconcile' })
  | (HostedCommandBase & {
      kind: 'retrigger';
      pipeline: AgentPipeline;
    });

export type HostedControllerCommandResult = {
  ok: true;
  requestId: string;
};

/**
 * Execute a typed command inside the authenticated console backend. The
 * request UUID is both the controller source identity and the stable
 * transport identity, so an HTTP/server-action retry replays the same
 * transition instead of minting another generation.
 */
export async function executeHostedControllerCommand(
  command: HostedControllerCommand,
): Promise<HostedControllerCommandResult> {
  const octokit = getGithubClient();
  const repository = repoKey(command.repository);
  const [{ data: liveIssue }, { data: liveRepository }] = await Promise.all([
    octokit.rest.issues.get({
      owner: command.repository.owner,
      repo: command.repository.name,
      issue_number: command.issueNumber,
    }),
    octokit.rest.repos.get({
      owner: command.repository.owner,
      repo: command.repository.name,
    }),
  ]);
  const transportId = Number.parseInt(
    createHash('sha256').update(command.requestId).digest('hex').slice(0, 13),
    16,
  );
  const normalized = normalizeEvent({
    eventName: 'workflow_dispatch',
    event: { action: '', issue: liveIssue as IssueOrPullRequest },
    inputs:
      command.kind === 'reconcile'
        ? { kind: 'reconcile' }
        : {
            pipeline: command.pipeline,
            mode: 'implement',
            caller_id: command.requestId,
          },
    context: {
      repository,
      repositoryId: liveRepository.id,
      issue: command.issueNumber,
      runId: transportId,
      now: new Date().toISOString(),
      actor: maintainerLogin(),
    },
    maintainer: maintainerLogin(),
  });

  await processHostedControllerEvent({
    normalized,
    isPullRequest: Boolean(liveIssue.pull_request),
    transportRunId: transportId,
    authorityOwner: `console-command:${command.requestId}`,
  });
  return { ok: true, requestId: command.requestId };
}
