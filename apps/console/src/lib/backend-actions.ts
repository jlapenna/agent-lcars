import {
  getGithubClient,
  primaryWatchedRepo,
  type WatchedRepo,
} from './github-client';
import { type Pipeline } from './primary-action';
import {
  type AgentIntegration,
  agentIntegration,
  selectedAgentPipeline,
  supportedAgentPipelines,
} from './watched-repo';

export class ActionError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'ActionError';
  }
}

function replyTriggers(integration: AgentIntegration): string[] {
  return [integration.replyTrigger, ...(integration.replyTriggerAliases ?? [])];
}

function containsReplyTrigger(
  body: string,
  integration: AgentIntegration,
): boolean {
  const normalized = body.toLowerCase();
  return replyTriggers(integration).some((trigger) =>
    normalized.includes(trigger.toLowerCase()),
  );
}

// A console reply must carry the repository integration's declared trigger,
// unless the body already contains that trigger or one of its aliases.
function ensureReplyTrigger(
  body: string,
  integration: AgentIntegration,
): string {
  return containsReplyTrigger(body, integration)
    ? body
    : `${body}\n\n${integration.replyTrigger}`;
}

function requireAgentIntegration(repo: WatchedRepo, pipeline: Pipeline) {
  const integration = agentIntegration(repo, pipeline);
  if (!integration) {
    throw new ActionError(
      `${repo.owner}/${repo.name} does not declare a ${pipeline} agent integration`,
      400,
    );
  }
  return integration;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: unknown }).status === 404
  );
}

// Replying or retriggering hands the ball back to the agent. The agent
// applies `status:needs-human`; handing work back clears it centrally. Also
// exposed as its own console action for stale trackers that need no reply.
export async function clearNeedsHumanLabel(
  repo: WatchedRepo,
  issueNumber: number,
): Promise<void> {
  const octokit = getGithubClient();
  try {
    await octokit.rest.issues.removeLabel({
      owner: repo.owner,
      repo: repo.name,
      issue_number: issueNumber,
      name: 'status:needs-human',
    });
  } catch (error) {
    // 404 = the label wasn't set. Anything else: the primary action already
    // succeeded, so a failed label cleanup should not fail the request.
    if (!isNotFound(error)) {
      // %s, not a template literal: issueNumber is declared `number`, but a
      // Server Action's arguments aren't runtime-type-checked at the HTTP
      // boundary, so treat it as untrusted input here (CodeQL
      // js/tainted-format-string) rather than interpolating it into the
      // format string itself.
      console.error(
        'agent-lcars: failed to clear status:needs-human on #%s:',
        issueNumber,
        error,
      );
    }
  }
}

// Server-action API compatibility; the GitHub label itself is
// `status:needs-human` and all label access is centralized above.
export const clearHumanNeededLabel = clearNeedsHumanLabel;

export async function postComment(
  repo: WatchedRepo,
  issueNumber: number,
  body: string,
  labels: string[] = [],
): Promise<{ url: string }> {
  if (!body.trim()) {
    throw new ActionError('Comment body is required', 400);
  }
  const octokit = getGithubClient();
  const selectedPipeline = selectedAgentPipeline(repo, labels);
  const integration = selectedPipeline
    ? requireAgentIntegration(repo, selectedPipeline)
    : undefined;
  const { data } = await octokit.rest.issues.createComment({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    body: integration ? ensureReplyTrigger(body, integration) : body,
  });
  await clearNeedsHumanLabel(repo, issueNumber);
  return { url: data.html_url };
}

export async function approveAndMergePr(
  repo: WatchedRepo,
  prNumber: number,
): Promise<void> {
  const octokit = getGithubClient();

  await octokit.rest.pulls.createReview({
    owner: repo.owner,
    repo: repo.name,
    pull_number: prNumber,
    event: 'APPROVE',
  });

  await octokit.rest.pulls.merge({
    owner: repo.owner,
    repo: repo.name,
    pull_number: prNumber,
    merge_method: 'squash',
  });
}

// Resolves the `behind` mergeable_state ("Base branch has moved" in
// action-item-card.tsx's MERGEABLE_WARNINGS) the same way GitHub's own
// "Update branch" button does: merges the base branch into the PR branch,
// rather than a true rebase, since that's all the update-branch REST
// endpoint offers.
export async function updatePrBranch(
  repo: WatchedRepo,
  prNumber: number,
): Promise<void> {
  const octokit = getGithubClient();
  await octokit.rest.pulls.updateBranch({
    owner: repo.owner,
    repo: repo.name,
    pull_number: prNumber,
  });
}

// GitHub's REST API has no "enable auto-merge" endpoint - only the GraphQL
// schema exposes enablePullRequestAutoMerge, and it's keyed by the PR's
// GraphQL node ID rather than its REST pull number.
const ENABLE_AUTO_MERGE_MUTATION = `
  mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
    enablePullRequestAutoMerge(
      input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }
    ) {
      clientMutationId
    }
  }
`;

// The "Approve & Rebase" counterpart to approveAndMergePr, used instead of
// it once the PR's branch has fallen behind its base (mergeableState
// 'behind' - see derivePrimaryAction): approves, then brings the branch up
// to date and turns on auto-merge so the PR lands on its own once checks
// pass, rather than merging immediately against a stale base. GitHub's
// update-branch endpoint actually merges the base into head (a merge
// commit), not a literal git rebase - but it's the same maintainer intent
// this button's name promises: catch the PR up, then let it land.
export async function approveAndRebasePr(
  repo: WatchedRepo,
  prNumber: number,
): Promise<void> {
  const octokit = getGithubClient();

  await octokit.rest.pulls.createReview({
    owner: repo.owner,
    repo: repo.name,
    pull_number: prNumber,
    event: 'APPROVE',
  });

  await octokit.rest.pulls.updateBranch({
    owner: repo.owner,
    repo: repo.name,
    pull_number: prNumber,
  });

  const { data: pr } = await octokit.rest.pulls.get({
    owner: repo.owner,
    repo: repo.name,
    pull_number: prNumber,
  });

  // Squash, matching approveAndMergePr's own merge_method - the two buttons
  // should produce the same merge shape, differing only in whether the
  // branch needed catching up first.
  await octokit.graphql(ENABLE_AUTO_MERGE_MUTATION, {
    pullRequestId: pr.node_id,
    mergeMethod: 'SQUASH',
  });
}

// The console's "Done" affordance for a loop that's simply finished (stale
// tracker, question answered elsewhere, agent PR abandoned) - closes without
// requiring a trip to GitHub.
export async function closeIssue(
  repo: WatchedRepo,
  issueNumber: number,
): Promise<void> {
  const octokit = getGithubClient();
  await octokit.rest.issues.update({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    state: 'closed',
  });
}

export async function cancelWorkflowRun(
  repo: WatchedRepo,
  runId: number,
): Promise<void> {
  const octokit = getGithubClient();
  await octokit.rest.actions.cancelWorkflowRun({
    owner: repo.owner,
    repo: repo.name,
    run_id: runId,
  });
}

// Dispatches the same workflow_dispatch event a human triggers from the
// Actions tab or `gh workflow run` — see playbook-unstick-prs.yml.
const DEFAULT_BRANCH = 'main';
const AGENT_ROUTER_WORKFLOW = 'agent-router.yml';

// dispatchUnstickPrs is a global console-level ops action, not scoped to any
// one action item. Unlike createQuickTask below, it has neither a repo
// picker (#11 only added one to quick-task-button.tsx) nor a tracked
// follow-up to add one - it simply targets the primary watched repo.
export async function dispatchUnstickPrs(
  context?: string,
  repo: WatchedRepo = primaryWatchedRepo(),
): Promise<void> {
  const octokit = getGithubClient();
  const trimmedContext = context?.trim();
  await octokit.rest.actions.createWorkflowDispatch({
    owner: repo.owner,
    repo: repo.name,
    workflow_id: 'playbook-unstick-prs.yml',
    ref: DEFAULT_BRANCH,
    inputs: trimmedContext ? { context: trimmedContext } : {},
  });
}

export async function retriggerIssue(
  repo: WatchedRepo,
  issueNumber: number,
  note?: string,
  pipeline: Pipeline = 'claude',
): Promise<void> {
  const octokit = getGithubClient();
  const integration = requireAgentIntegration(repo, pipeline);
  // Pipeline names intentionally match the dispatch router's choice inputs.
  const label = integration.label;

  const { data: issue } = await octokit.rest.issues.get({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
  });
  const hasLabel = issue.labels.some((issueLabel) =>
    typeof issueLabel === 'string'
      ? issueLabel === label
      : issueLabel.name === label,
  );
  if (!hasLabel) {
    throw new ActionError(
      `Issue does not carry the ${label} label; nothing to retrigger`,
      400,
    );
  }

  await clearNeedsHumanLabel(repo, issueNumber);

  // A steering note goes up BEFORE the retrigger so the fresh run reads it
  // as part of the thread. Deliberately NOT run through ensureMention: a
  // comment already containing the pipeline's own mention dispatches a run
  // through the direct reply path, so dispatching here would double-run it.
  const trimmedNote = note?.trim();
  if (trimmedNote) {
    await octokit.rest.issues.createComment({
      owner: repo.owner,
      repo: repo.name,
      issue_number: issueNumber,
      body: trimmedNote,
    });
    if (containsReplyTrigger(trimmedNote, integration)) {
      return;
    }
  }

  await octokit.rest.actions.createWorkflowDispatch({
    owner: repo.owner,
    repo: repo.name,
    workflow_id: AGENT_ROUTER_WORKFLOW,
    ref: DEFAULT_BRANCH,
    inputs: {
      issue: String(issueNumber),
      pipeline,
      mode: 'implement',
    },
  });
}

// The console's "hand this off to a different agent" action (#143) - e.g. a
// codex run got stuck and the maintainer wants claude to pick it up instead.
// Distinct from retriggerIssue's same-pipeline cycle: this swaps which
// pipeline label the issue carries rather than re-firing the one it already
// has.
export async function reassignPipeline(
  repo: WatchedRepo,
  issueNumber: number,
  targetPipeline: Pipeline,
): Promise<void> {
  const octokit = getGithubClient();
  const targetIntegration = requireAgentIntegration(repo, targetPipeline);

  const { data: issue } = await octokit.rest.issues.get({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
  });
  const currentLabels = issue.labels.map((label) =>
    typeof label === 'string' ? label : (label.name ?? ''),
  );
  const currentPipelineLabels = supportedAgentPipelines(repo)
    .map((pipeline) => agentIntegration(repo, pipeline)?.label)
    .filter((label): label is string => Boolean(label))
    .filter((label) => currentLabels.includes(label));
  if (currentPipelineLabels.includes(targetIntegration.label)) {
    throw new ActionError(
      `Issue is already assigned to ${targetPipeline}`,
      400,
    );
  }
  if (currentPipelineLabels.length === 0) {
    throw new ActionError(
      'Issue does not carry a pipeline label; nothing to reassign',
      400,
    );
  }

  await clearNeedsHumanLabel(repo, issueNumber);

  // Drop every other agent label first. The router also enforces this
  // invariant for direct GitHub label changes, so the console and GitHub
  // paths cannot diverge.
  for (const label of currentPipelineLabels) {
    await octokit.rest.issues.removeLabel({
      owner: repo.owner,
      repo: repo.name,
      issue_number: issueNumber,
      name: label,
    });
  }

  // Adding the target label fires the centralized agent-router workflow;
  // there is no pipeline-specific label listener anymore.
  await octokit.rest.issues.addLabels({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    labels: [targetIntegration.label],
  });
}

const QUICK_TASK_LABEL = 'intake:quick-task';
// Issue titles show up in list views and the run-name banner - a raw,
// possibly multi-paragraph task description would blow both out, so this
// keeps just the first line and clips it to something scannable.
const QUICK_TASK_TITLE_MAX_LENGTH = 80;

export function deriveQuickTaskTitle(description: string): string {
  const firstLine = description.split('\n', 1)[0].replace(/\s+/g, ' ').trim();
  if (firstLine.length <= QUICK_TASK_TITLE_MAX_LENGTH) return firstLine;
  return `${firstLine.slice(0, QUICK_TASK_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

// Defaults to the primary watched repo; quick-task-button.tsx overrides
// this via its own repo picker once more than one repo is watched (#11), and
// to the `claude` pipeline; quick-task-button.tsx overrides this via its own
// agent picker (#78).
export async function createQuickTask(
  description: string,
  title?: string,
  repo: WatchedRepo = primaryWatchedRepo(),
  pipeline: Pipeline = 'claude',
): Promise<{ url: string; number: number }> {
  const trimmed = description.trim();
  if (!trimmed) {
    throw new ActionError('Task description is required', 400);
  }
  const trimmedTitle = title?.trim();
  const integration = requireAgentIntegration(repo, pipeline);

  const octokit = getGithubClient();
  const { data: issue } = await octokit.rest.issues.create({
    owner: repo.owner,
    repo: repo.name,
    title: trimmedTitle || deriveQuickTaskTitle(trimmed),
    body: trimmed,
    labels: [QUICK_TASK_LABEL],
  });

  // Add the pipeline label after creation so the pipeline's labeled event is
  // distinct from the intake label event. GitHub emits both events (even
  // when the first label is supplied to issues.create); the workflow
  // concurrency groups in the serialized pipelines isolate the non-pipeline
  // event so it can skip without appearing as a second queued agent run.
  await octokit.rest.issues.addLabels({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issue.number,
    labels: [integration.label],
  });

  return { url: issue.html_url, number: issue.number };
}
