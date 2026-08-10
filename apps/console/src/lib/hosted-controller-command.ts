import 'server-only';

import { createHash } from 'node:crypto';

import {
  type IssueOrPullRequest,
  normalizeEvent,
} from '@agent-lcars/dispatch-controller/normalize';
import { optional } from '@agent-lcars/util-server';

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
    })
  | (HostedCommandBase & {
      kind: 'reassign-pipeline';
      targetPipeline: AgentPipeline;
      /** This repo's configured `agent:*` label for `targetPipeline`
       *  (`agentIntegration(repo, targetPipeline).label` -- may differ from
       *  the fleet-wide default via `WatchedRepo.agents`). */
      targetLabel: string;
      /** Every `agent:*` label this repo's own integrations declare;
       *  always includes `targetLabel`. What the controller recognizes as
       *  "a pipeline selection" when validating the anchor's live label
       *  state, instead of reconstructing it from the fleet-wide default. */
      pipelineLabels: string[];
    });

export type HostedControllerCommandResult = {
  ok: true;
  requestId: string;
};

/** normalizeEvent's own `workflow_dispatch` input shape, one variant per
 *  `HostedControllerCommand` kind -- kept as its own function so the
 *  exhaustiveness of the switch (not a chained ternary) is what the
 *  compiler checks when a fourth kind is added later. */
function normalizeInputsFor(command: HostedControllerCommand) {
  switch (command.kind) {
    case 'reconcile':
      return { kind: 'reconcile' as const };
    case 'retrigger':
      return {
        pipeline: command.pipeline,
        mode: 'implement',
        caller_id: command.requestId,
      };
    case 'reassign-pipeline':
      return {
        kind: 'reassign-pipeline' as const,
        pipeline: command.targetPipeline,
        target_label: command.targetLabel,
        pipeline_labels: JSON.stringify(command.pipelineLabels),
        caller_id: command.requestId,
      };
  }
}

async function executeE2eControllerCommand(
  baseUrl: string,
  command: HostedControllerCommand,
): Promise<HostedControllerCommandResult> {
  const response = await fetch(`${baseUrl}/controller-commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    throw new Error(
      `E2E hosted controller command failed: HTTP ${response.status}`,
    );
  }
  return { ok: true, requestId: command.requestId };
}

/**
 * Execute a typed command inside the authenticated console backend. The
 * request UUID is both the controller source identity and the stable
 * transport identity, so an HTTP/server-action retry replays the same
 * transition instead of minting another generation.
 */
export async function executeHostedControllerCommand(
  command: HostedControllerCommand,
): Promise<HostedControllerCommandResult> {
  // The hermetic browser suite points every GitHub interaction at its local
  // fixture and deliberately owns no production controller authority epoch.
  // Exercise the typed command boundary there without opening a second,
  // fixture-only controller implementation.
  const e2eGithubBaseUrl = optional('AGENT_CONSOLE_GITHUB_API_BASE_URL');
  if (e2eGithubBaseUrl) {
    return executeE2eControllerCommand(e2eGithubBaseUrl, command);
  }
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
    inputs: normalizeInputsFor(command),
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
