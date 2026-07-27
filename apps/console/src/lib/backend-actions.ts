import {
  getGithubClient,
  primaryWatchedRepo,
  type WatchedRepo,
} from './github-client';
import { type Pipeline, pipelineForLabels } from './primary-action';

export class ActionError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'ActionError';
  }
}

// The comment string ensured/appended when a reply doesn't already trigger
// the target pipeline. "/oc" is the shorter of opencode.yml's two accepted
// triggers (`contains(body, '/opencode') || contains(body, '/oc')`) and
// sufficient on its own.
const PIPELINE_MENTION: Record<Pipeline, string> = {
  claude: '@claude',
  codex: '/codex',
  opencode: '/oc',
};

// Whether a body ALREADY triggers the target pipeline - has to check both
// of opencode.yml's accepted strings, since neither is a substring of the
// other ("/opencode" does NOT contain "/oc": the third character is 'p',
// not 'c').
const PIPELINE_MENTION_RE: Record<Pipeline, RegExp> = {
  claude: /@claude/i,
  codex: /\/codex/i,
  opencode: /\/opencode|\/oc/i,
};

// The target pipeline's issue_comment trigger only fires for comments that
// contain its mention string - a reply posted from this console has to
// carry it too, or the agent will never see it.
function ensureMention(body: string, pipeline: Pipeline): string {
  return PIPELINE_MENTION_RE[pipeline].test(body)
    ? body
    : `${body}\n\n${PIPELINE_MENTION[pipeline]}`;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: unknown }).status === 404
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: unknown }).status === 422
  );
}

// Replying or retriggering hands the ball back to the agent. The agent
// applies `human-needed` but nothing ever cleared it, so answered items
// stayed pinned to the top of "Needs Your Action" indefinitely. Also exposed
// directly as its own console action, for when a reply isn't warranted (the
// question was answered elsewhere, the tracker is stale) but the label
// still needs clearing.
export async function clearHumanNeededLabel(
  repo: WatchedRepo,
  issueNumber: number,
): Promise<void> {
  const octokit = getGithubClient();
  try {
    await octokit.rest.issues.removeLabel({
      owner: repo.owner,
      repo: repo.name,
      issue_number: issueNumber,
      name: 'human-needed',
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
        'agent-lcars: failed to clear human-needed on #%s:',
        issueNumber,
        error,
      );
    }
  }
}

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
  const { data } = await octokit.rest.issues.createComment({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    body: ensureMention(body, pipelineForLabels(labels)),
  });
  await clearHumanNeededLabel(repo, issueNumber);
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
  // Pipeline's two values ('claude' | 'opencode') are themselves the label
  // names that dispatch each pipeline (claude.yml / opencode.yml's
  // `issues: labeled` triggers) - no separate lookup table needed.
  const label: string = pipeline;

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

  await clearHumanNeededLabel(repo, issueNumber);

  // A steering note goes up BEFORE the retrigger so the fresh run reads it
  // as part of the thread. Deliberately NOT run through ensureMention: on a
  // labeled issue a comment already containing the pipeline's own mention
  // dispatches a run all by itself, so appending it here and then cycling
  // the label would double-dispatch. Same reason for the early return below
  // when the note already carries it.
  const trimmedNote = note?.trim();
  if (trimmedNote) {
    await octokit.rest.issues.createComment({
      owner: repo.owner,
      repo: repo.name,
      issue_number: issueNumber,
      body: trimmedNote,
    });
    if (PIPELINE_MENTION_RE[pipeline].test(trimmedNote)) {
      return;
    }
  }

  // Removing then re-adding the label is the only way to re-fire the
  // `issues: labeled` trigger on the same label value.
  await octokit.rest.issues.removeLabel({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    name: label,
  });
  await octokit.rest.issues.addLabels({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    labels: [label],
  });
}

const PIPELINE_LABELS: Pipeline[] = ['claude', 'codex', 'opencode'];

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

  const { data: issue } = await octokit.rest.issues.get({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
  });
  const currentLabels = issue.labels.map((label) =>
    typeof label === 'string' ? label : (label.name ?? ''),
  );
  const currentPipelineLabels = PIPELINE_LABELS.filter((label) =>
    currentLabels.includes(label),
  );
  if (currentPipelineLabels.includes(targetPipeline)) {
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

  await clearHumanNeededLabel(repo, issueNumber);

  // Drop every other pipeline label first - pipelineForLabels' claude >
  // codex > opencode precedence means a stray leftover label could route a
  // future reply/retrigger back to the old pipeline even after this
  // hand-off.
  for (const label of currentPipelineLabels) {
    await octokit.rest.issues.removeLabel({
      owner: repo.owner,
      repo: repo.name,
      issue_number: issueNumber,
      name: label,
    });
  }

  // Adding a label the issue didn't already carry fires the target
  // pipeline's own `issues: labeled` trigger by itself - no remove-then-readd
  // cycle needed here, unlike retriggerIssue's same-label case.
  await octokit.rest.issues.addLabels({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    labels: [targetPipeline],
  });
}

const QUICK_TASK_LABEL = 'quick-task';
// Issue titles show up in list views and the run-name banner - a raw,
// possibly multi-paragraph task description would blow both out, so this
// keeps just the first line and clips it to something scannable.
const QUICK_TASK_TITLE_MAX_LENGTH = 80;

export function deriveQuickTaskTitle(description: string): string {
  const firstLine = description.split('\n', 1)[0].replace(/\s+/g, ' ').trim();
  if (firstLine.length <= QUICK_TASK_TITLE_MAX_LENGTH) return firstLine;
  return `${firstLine.slice(0, QUICK_TASK_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

async function ensureQuickTaskLabelExists(repo: WatchedRepo): Promise<void> {
  const octokit = getGithubClient();
  try {
    await octokit.rest.issues.createLabel({
      owner: repo.owner,
      repo: repo.name,
      name: QUICK_TASK_LABEL,
      color: '5319E7',
      description: 'Filed via the Agent LCARS quick task button',
    });
  } catch (error) {
    // 422 = the label already exists; anything else is a real failure.
    if (!isAlreadyExists(error)) throw error;
  }
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

  await ensureQuickTaskLabelExists(repo);

  const octokit = getGithubClient();
  const { data: issue } = await octokit.rest.issues.create({
    owner: repo.owner,
    repo: repo.name,
    title: trimmedTitle || deriveQuickTaskTitle(trimmed),
    body: trimmed,
    labels: [QUICK_TASK_LABEL],
  });

  // Added as a follow-up call rather than in the labels above: GitHub only
  // fires the `issues: labeled` webhook event each pipeline's workflow
  // listens for when a label is attached after creation, not for one
  // included in the create() call itself. Same reasoning as
  // retriggerIssue's remove-then-readd above. The label IS the pipeline
  // name (see retriggerIssue's identical `label: string = pipeline` above).
  await octokit.rest.issues.addLabels({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issue.number,
    labels: [pipeline],
  });

  return { url: issue.html_url, number: issue.number };
}
