import { getGithubClient, REPO_NAME, REPO_OWNER } from './github-client';

export class ActionError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'ActionError';
  }
}

// The claude.yml workflow's issue_comment trigger only fires for comments
// that contain the literal "@claude" - a reply posted from this console has
// to carry it too, or the agent will never see it.
function ensureTriggersAgent(body: string): string {
  return /@claude/i.test(body) ? body : `${body}\n\n@claude`;
}

export async function postComment(
  issueNumber: number,
  body: string,
): Promise<{ url: string }> {
  if (!body.trim()) {
    throw new ActionError('Comment body is required', 400);
  }
  const octokit = getGithubClient();
  const { data } = await octokit.rest.issues.createComment({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: issueNumber,
    body: ensureTriggersAgent(body),
  });
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

export async function retriggerIssue(
  issueNumber: number,
  note?: string,
): Promise<void> {
  const octokit = getGithubClient();

  const { data: issue } = await octokit.rest.issues.get({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: issueNumber,
  });
  const hasClaudeLabel = issue.labels.some((label) =>
    typeof label === 'string' ? label === 'claude' : label.name === 'claude',
  );
  if (!hasClaudeLabel) {
    throw new ActionError(
      'Issue does not carry the claude label; nothing to retrigger',
      400,
    );
  }

  // A steering note goes up BEFORE the retrigger so the fresh run reads it
  // as part of the thread. Deliberately NOT run through ensureTriggersAgent:
  // on a claude-labeled issue a comment containing @claude dispatches a run
  // all by itself, so appending it here and then cycling the label would
  // double-dispatch. Same reason for the early return below when the note
  // already carries @claude.
  const trimmedNote = note?.trim();
  if (trimmedNote) {
    await octokit.rest.issues.createComment({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      issue_number: issueNumber,
      body: trimmedNote,
    });
    if (/@claude/i.test(trimmedNote)) {
      return;
    }
  }

  // Removing then re-adding the label is the only way to re-fire the
  // `issues: labeled` trigger on the same label value.
  await octokit.rest.issues.removeLabel({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: issueNumber,
    name: 'claude',
  });
  await octokit.rest.issues.addLabels({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: issueNumber,
    labels: ['claude'],
  });
}
