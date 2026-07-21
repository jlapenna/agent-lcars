import { getGithubClient, REPO_NAME, REPO_OWNER } from './github-client';
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
  issueNumber: number,
): Promise<void> {
  const octokit = getGithubClient();
  try {
    await octokit.rest.issues.removeLabel({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      issue_number: issueNumber,
      name: 'human-needed',
    });
  } catch (error) {
    // 404 = the label wasn't set. Anything else: the primary action already
    // succeeded, so a failed label cleanup should not fail the request.
    if (!isNotFound(error)) {
      console.error(
        `agent-console: failed to clear human-needed on #${issueNumber}:`,
        error,
      );
    }
  }
}

export async function postComment(
  issueNumber: number,
  body: string,
  labels: string[] = [],
): Promise<{ url: string }> {
  if (!body.trim()) {
    throw new ActionError('Comment body is required', 400);
  }
  const octokit = getGithubClient();
  const { data } = await octokit.rest.issues.createComment({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: issueNumber,
    body: ensureMention(body, pipelineForLabels(labels)),
  });
  await clearHumanNeededLabel(issueNumber);
  return { url: data.html_url };
}

export async function approveAndMergePr(prNumber: number): Promise<void> {
  const octokit = getGithubClient();

  await octokit.rest.pulls.createReview({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    pull_number: prNumber,
    event: 'APPROVE',
  });

  await octokit.rest.pulls.merge({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    pull_number: prNumber,
    merge_method: 'squash',
  });
}

// The console's "Done" affordance for a loop that's simply finished (stale
// tracker, question answered elsewhere, agent PR abandoned) - closes without
// requiring a trip to GitHub.
export async function closeIssue(issueNumber: number): Promise<void> {
  const octokit = getGithubClient();
  await octokit.rest.issues.update({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: issueNumber,
    state: 'closed',
  });
}

export async function cancelWorkflowRun(runId: number): Promise<void> {
  const octokit = getGithubClient();
  await octokit.rest.actions.cancelWorkflowRun({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    run_id: runId,
  });
}

// Both playbook dispatches below POST the same workflow_dispatch event a
// human triggers from the Actions tab or `gh workflow run` — see
// playbook-unstick-prs.yml / playbook-evict-nx-cache.yml.
const DEFAULT_BRANCH = 'main';

export async function dispatchUnstickPrs(context?: string): Promise<void> {
  const octokit = getGithubClient();
  const trimmedContext = context?.trim();
  await octokit.rest.actions.createWorkflowDispatch({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    workflow_id: 'playbook-unstick-prs.yml',
    ref: DEFAULT_BRANCH,
    inputs: trimmedContext ? { context: trimmedContext } : {},
  });
}

export async function evictNxCache(capture: boolean): Promise<void> {
  const octokit = getGithubClient();
  await octokit.rest.actions.createWorkflowDispatch({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    workflow_id: 'playbook-evict-nx-cache.yml',
    ref: DEFAULT_BRANCH,
    inputs: { capture: String(capture) },
  });
}

export async function retriggerIssue(
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
    owner: REPO_OWNER,
    repo: REPO_NAME,
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

  await clearHumanNeededLabel(issueNumber);

  // A steering note goes up BEFORE the retrigger so the fresh run reads it
  // as part of the thread. Deliberately NOT run through ensureMention: on a
  // labeled issue a comment already containing the pipeline's own mention
  // dispatches a run all by itself, so appending it here and then cycling
  // the label would double-dispatch. Same reason for the early return below
  // when the note already carries it.
  const trimmedNote = note?.trim();
  if (trimmedNote) {
    await octokit.rest.issues.createComment({
      owner: REPO_OWNER,
      repo: REPO_NAME,
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
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: issueNumber,
    name: label,
  });
  await octokit.rest.issues.addLabels({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: issueNumber,
    labels: [label],
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

async function ensureQuickTaskLabelExists(): Promise<void> {
  const octokit = getGithubClient();
  try {
    await octokit.rest.issues.createLabel({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      name: QUICK_TASK_LABEL,
      color: '5319E7',
      description: 'Filed via the agent console quick task button',
    });
  } catch (error) {
    // 422 = the label already exists; anything else is a real failure.
    if (!isAlreadyExists(error)) throw error;
  }
}

export async function createQuickTask(
  description: string,
  title?: string,
): Promise<{ url: string; number: number }> {
  const trimmed = description.trim();
  if (!trimmed) {
    throw new ActionError('Task description is required', 400);
  }
  const trimmedTitle = title?.trim();

  await ensureQuickTaskLabelExists();

  const octokit = getGithubClient();
  const { data: issue } = await octokit.rest.issues.create({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    title: trimmedTitle || deriveQuickTaskTitle(trimmed),
    body: trimmed,
    labels: [QUICK_TASK_LABEL],
  });

  // Added as a follow-up call rather than in the labels above: GitHub only
  // fires the `issues: labeled` webhook event that claude.yml listens for
  // when a label is attached after creation, not for one included in the
  // create() call itself. Same reasoning as retriggerIssue's remove-then-
  // readd above. Always the `claude` pipeline, intentionally: quick tasks
  // are fire-and-forget maintainer asks, and opencode is an experimental
  // pipeline you opt into per-issue by labeling it yourself (#3023).
  await octokit.rest.issues.addLabels({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: issue.number,
    labels: ['claude'],
  });

  return { url: issue.html_url, number: issue.number };
}
