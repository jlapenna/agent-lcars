import { createHash, randomUUID } from 'node:crypto';

import {
  formatQuickTaskMarker,
  parseTerminalQuickTaskBody,
  quickTaskDigest as sharedQuickTaskDigest,
  quickTaskMarkerMatcher,
} from '@agent-lcars/dispatch-contracts';

import { issueNumberFromDisplayTitle } from './agent-activity';
import {
  getGithubClient,
  primaryWatchedRepo,
  type WatchedRepo,
} from './github-client';
import { type Pipeline } from './primary-action';
import type { QuickTaskReceipt, QuickTaskRequest } from './quick-task-contract';
import { deriveQuickTaskTitle } from './quick-task-evidence';
import {
  type AgentIntegration,
  agentIntegration,
  repoKey,
  selectedAgentPipeline,
  supportedAgentPipelines,
  taskRefUrl,
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
  let fenced = false;
  const triggers = replyTriggers(integration).map((trigger) =>
    trigger.toLowerCase(),
  );
  return body.split(/\r?\n/u).some((rawLine) => {
    const line = rawLine.trim().toLowerCase();
    if (line.startsWith('```')) {
      fenced = !fenced;
      return false;
    }
    if (fenced || line.startsWith('>')) return false;
    return triggers.some(
      (trigger) => line === trigger || line.startsWith(`${trigger} `),
    );
  });
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

export function isNotFound(error: unknown): boolean {
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
    // Either way, the label write itself did not happen (already absent, or
    // failed outright) - the park state the ledger cares about is
    // unchanged, so there is nothing new for the controller to converge.
    return;
  }
  // The park state the ledger tracks just changed on GitHub - nudge the
  // controller to pick it up now instead of on the next scheduled sweep.
  await notifyReconcile(repo, issueNumber);
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

  // Reconcile the PR anchor the console actually knows. A `Fixes #N` in the
  // PR body can also auto-close a *linked issue* as a side effect of this
  // merge - a second anchor this function was never given and has no
  // reliable way to identify from prNumber alone (the PR body would have to
  // be parsed for closing keywords, which is exactly the kind of guessing
  // this ping is meant to avoid). That anchor is left to
  // dispatch-reconcile.yml's scheduled sweep, which #715 already taught to
  // converge a closed anchor's `control.closed` on its own.
  await notifyReconcile(repo, prNumber);
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
  // `control.closed` just changed on GitHub without the router ever seeing
  // an `issues: closed` event (this console action, not a webhook, wrote
  // it) - nudge the controller to converge now instead of waiting on
  // dispatch-reconcile.yml's next scheduled sweep.
  await notifyReconcile(repo, issueNumber);
}

/** Updates the human-authored issue content without changing any dispatch
 * control fields. Title/body edits do not affect the ledger's close/park/
 * pipeline state, so unlike close and label mutations this deliberately
 * does not ping reconciliation. */
export async function updateIssueContent(
  repo: WatchedRepo,
  issueNumber: number,
  content: { title: string; body: string },
): Promise<void> {
  if (!content || typeof content.title !== 'string') {
    throw new ActionError('Issue title is required', 400);
  }
  const title = content.title.trim();
  if (!title) {
    throw new ActionError('Issue title is required', 400);
  }
  if (typeof content.body !== 'string') {
    throw new ActionError('Issue body must be text', 400);
  }

  const octokit = getGithubClient();
  const { data: existing } = await octokit.rest.issues.get({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
  });
  const existingBody = existing.body ?? '';
  const quickTask = parseTerminalQuickTaskBody(existingBody);
  if (
    existingBody.includes('<!-- agent-lcars:quick-task-request:v1') &&
    !quickTask
  ) {
    throw new ActionError(
      'Quick Task identity marker is malformed; refusing to edit',
      409,
    );
  }

  let body = content.body;
  const submittedQuickTask = parseTerminalQuickTaskBody(content.body);
  if (
    content.body.includes('<!-- agent-lcars:quick-task-request:v1') &&
    !submittedQuickTask
  ) {
    throw new ActionError('Quick Task identity marker is malformed', 400);
  }
  if (!quickTask && submittedQuickTask) {
    throw new ActionError(
      'A Quick Task identity marker cannot be added through issue editing',
      400,
    );
  }
  if (quickTask) {
    const originalPipeline = supportedAgentPipelines(repo).find(
      (pipeline) =>
        sharedQuickTaskDigest(
          {
            repository: repoKey(repo),
            pipeline,
            title: existing.title,
            description: quickTask.description,
          },
          sha256Hex,
        ) === quickTask.digest,
    );
    if (!originalPipeline) {
      throw new ActionError(
        'Quick Task identity digest does not match its current content; refusing to edit',
        409,
      );
    }

    const description = (
      submittedQuickTask?.description ?? content.body
    ).trim();
    const digest = sharedQuickTaskDigest(
      {
        repository: repoKey(repo),
        pipeline: originalPipeline,
        title,
        description,
      },
      sha256Hex,
    );
    const marker = formatQuickTaskMarker({
      requestId: quickTask.requestId,
      digest,
    });
    body = description ? `${description}\n\n${marker}` : marker;
  }

  await octokit.rest.issues.update({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    title,
    body,
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
  // The run just killed may be the attempt.runId the ledger has bound as an
  // active generation - reconcile it now rather than waiting on the
  // scheduled sweep. cancelWorkflowRun's own signature carries no anchor
  // number, so notifyReconcileForCancelledRun looks one up from the run
  // itself before pinging.
  await notifyReconcileForCancelledRun(repo, runId);
}

// Dispatches the same workflow_dispatch event a human triggers from the
// Actions tab or `gh workflow run` — see playbook-unstick-prs.yml.
const DEFAULT_BRANCH = 'main';
const AGENT_ROUTER_WORKFLOW = 'agent-router.yml';
const DISPATCH_CALLER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// A watched repo's own agent-router.yml is a separate file that repo
// maintains independently (this codebase deliberately keeps no shared
// build context with a consuming repo - see AGENTS.md), so a newly added
// *optional* workflow_dispatch input like `caller_id` can reach a repo
// whose copy of the workflow predates it. GitHub rejects the whole
// dispatch with a 422 naming exactly the inputs it doesn't recognize
// (`Unexpected inputs provided: ["caller_id"]`) rather than ignoring them.
// Since every optional input this call sends has a documented fallback on
// the receiving end (see apps/dispatch-broker/src/normalize.ts's
// resolveCallerSourceId), retrying
// once without the rejected keys degrades gracefully instead of leaving
// retrigger permanently broken for a lagging repo.
const UNEXPECTED_INPUTS_PATTERN = /Unexpected inputs provided: (\[.*\])/u;

function withoutUnexpectedInputs(
  error: unknown,
  inputs: Record<string, string>,
): Record<string, string> | undefined {
  const message = error instanceof Error ? error.message : undefined;
  const match = message ? UNEXPECTED_INPUTS_PATTERN.exec(message) : null;
  if (!match) return undefined;
  let unexpectedKeys: unknown;
  try {
    unexpectedKeys = JSON.parse(match[1]);
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(unexpectedKeys) ||
    unexpectedKeys.length === 0 ||
    !unexpectedKeys.every((key): key is string => typeof key === 'string')
  ) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(inputs).filter(([key]) => !unexpectedKeys.includes(key)),
  );
}

// One workflow_dispatch POST at this repo's own agent-router.yml, with the
// same lagging-repo degrade every caller needs (see withoutUnexpectedInputs
// above): retry once with any input GitHub's 422 names as unrecognized,
// and only then let the failure propagate. retriggerIssue's own intent
// dispatch and notifyReconcile's follow-up `kind: reconcile` ping both
// route through this single function rather than each re-implementing the
// same retry dance.
async function dispatchAgentRouter(
  repo: WatchedRepo,
  inputs: Record<string, string>,
): Promise<void> {
  const octokit = getGithubClient();
  try {
    await octokit.rest.actions.createWorkflowDispatch({
      owner: repo.owner,
      repo: repo.name,
      workflow_id: AGENT_ROUTER_WORKFLOW,
      ref: DEFAULT_BRANCH,
      inputs,
    });
  } catch (error) {
    const retryInputs = withoutUnexpectedInputs(error, inputs);
    if (!retryInputs) throw error;
    await octokit.rest.actions.createWorkflowDispatch({
      owner: repo.owner,
      repo: repo.name,
      workflow_id: AGENT_ROUTER_WORKFLOW,
      ref: DEFAULT_BRANCH,
      inputs: retryInputs,
    });
  }
}

// After a console action mutates a fact the dispatch ledger tracks (a
// park-state label, `control.closed`, a merge, a cancelled active-
// generation run) without going through agent-router.yml itself, ping it
// with `kind: reconcile` for the affected anchor so the controller
// converges immediately instead of only picking up the change on
// dispatch-reconcile.yml's next scheduled sweep (up to 30 minutes later).
// #715 taught that scheduled sweep to eventually repair a diverged
// `control.closed`; this closes the latency gap at the source instead of
// relying solely on that backstop.
//
// The mutation this follows has already landed on GitHub by the time this
// runs, so any failure here - a lagging watched repo whose agent-router.yml
// predates `kind: reconcile` (422, degraded by dispatchAgentRouter above
// same as any other unrecognised input), one with no agent-router.yml at
// all (404), or a transient GitHub error - is logged and swallowed rather
// than surfaced to the caller. A red toast over a best-effort follow-up
// ping would be a worse bug than the stale ledger entry this exists to
// shrink; the scheduled sweep remains the backstop either way.
async function notifyReconcile(
  repo: WatchedRepo,
  anchorNumber: number,
): Promise<void> {
  try {
    await dispatchAgentRouter(repo, {
      kind: 'reconcile',
      issue: String(anchorNumber),
    });
  } catch (error) {
    console.error(
      'agent-lcars: failed to notify the dispatch controller to reconcile #%s:',
      anchorNumber,
      error,
    );
  }
}

// cancelWorkflowRun's own signature carries only a run id, not the
// issue/PR anchor closeIssue/approveAndMergePr's callers already supply -
// so the anchor is looked up from the run itself rather than threaded in.
// claude.yml/codex.yml/opencode.yml's `run-name` renders `#<N>: ...` into
// the run's `display_title`, the same field agent-activity.ts's
// issueNumberFromDisplayTitle already trusts to join a live run back to
// its issue for the dashboard. A run whose title doesn't parse (predates
// the run-name rollout, or was dispatched by hand outside the broker) has
// no anchor this console can identify from the run alone - reconcile is
// skipped for it and left to the scheduled sweep, the same "don't guess"
// posture approveAndMergePr takes for a merge's linked-issue anchor.
async function notifyReconcileForCancelledRun(
  repo: WatchedRepo,
  runId: number,
): Promise<void> {
  // GitHub acknowledges a cancellation request before the run becomes
  // terminal. Reconcile only after `status: completed`; an earlier pass sees
  // the still-active attempt and is a no-op. Keep this wait bounded so the
  // console action remains responsive, with the scheduled sweep as the
  // fallback when GitHub takes longer to finish cancellation.
  const pollDelaysMs = [0, 250, 500, 1000, 2000, 4000];
  let anchorNumber: number | undefined;
  for (const delayMs of pollDelaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const octokit = getGithubClient();
      const { data: run } = await octokit.rest.actions.getWorkflowRun({
        owner: repo.owner,
        repo: repo.name,
        run_id: runId,
      });
      anchorNumber ??= issueNumberFromDisplayTitle(run.display_title);
      if (run.status !== 'completed') continue;
    } catch (error) {
      console.error(
        'agent-lcars: failed to identify the anchor for cancelled run #%s:',
        runId,
        error,
      );
      return;
    }
    if (anchorNumber !== undefined) {
      await notifyReconcile(repo, anchorNumber);
    }
    return;
  }

  console.warn(
    'agent-lcars: cancelled run #%s did not become terminal before the reconcile wait expired; the scheduled sweep will converge it',
    runId,
  );
}

// dispatchUnstickPrs is console-level ops. A caller with a concrete item
// (the card's per-PR "Unstick") passes that item's repo; the bare header
// variant omits it and falls back to the primary watched repo.
export async function dispatchUnstickPrs(
  context?: string,
  repo?: WatchedRepo,
): Promise<void> {
  const targetRepo = repo ?? primaryWatchedRepo();
  const octokit = getGithubClient();
  const trimmedContext = context?.trim();
  try {
    await octokit.rest.actions.createWorkflowDispatch({
      owner: targetRepo.owner,
      repo: targetRepo.name,
      workflow_id: 'playbook-unstick-prs.yml',
      ref: DEFAULT_BRANCH,
      inputs: trimmedContext ? { context: trimmedContext } : {},
    });
  } catch (error) {
    // Deliberately fail loud rather than silently retargeting the primary
    // repo: a watched repo without the playbook (GitHub answers 404 for an
    // unknown workflow_id) needs the maintainer to know that, not an
    // unstick run against some other repository (Codex review on #493).
    if ((error as { status?: number }).status === 404) {
      throw new ActionError(
        `${targetRepo.owner}/${targetRepo.name} has no playbook-unstick-prs.yml - add the workflow there or dispatch from a primary-repo item`,
        404,
      );
    }
    throw error;
  }
}

export async function retriggerIssue(
  repo: WatchedRepo,
  issueNumber: number,
  callerId: string,
  note?: string,
  pipeline: Pipeline = 'claude',
): Promise<void> {
  if (!DISPATCH_CALLER_ID_PATTERN.test(callerId)) {
    throw new ActionError('A valid dispatch caller ID is required', 400);
  }
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

  const inputs = {
    issue: String(issueNumber),
    pipeline,
    mode: 'implement',
    caller_id: callerId,
  };
  await dispatchAgentRouter(repo, inputs);
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

  const allAgentLabels = supportedAgentPipelines(repo)
    .map((pipeline) => agentIntegration(repo, pipeline)?.label)
    .filter((label): label is string => Boolean(label));
  const labels = currentLabels
    .filter((label) => !allAgentLabels.includes(label))
    .filter((label) => label !== 'status:needs-human')
    .concat(targetIntegration.label);

  // One set operation is the control-plane transition. It preserves every
  // unrelated label while ensuring GitHub never exposes an intermediate
  // zero-agent or contradictory multi-agent selection to the router.
  await octokit.rest.issues.setLabels({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    labels,
  });
}

/** Assigns an unclaimed open issue to an agent pipeline. */
export async function assignPipeline(
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
  if (issue.state !== 'open' || issue.pull_request) {
    throw new ActionError('Only open issues can be assigned to an agent', 400);
  }
  const labels = issue.labels.map((label) =>
    typeof label === 'string' ? label : (label.name ?? ''),
  );
  const agentLabels = supportedAgentPipelines(repo)
    .map((pipeline) => agentIntegration(repo, pipeline)?.label)
    .filter((label): label is string => Boolean(label));
  if (labels.some((label) => agentLabels.includes(label))) {
    throw new ActionError('Issue already has an agent assignment', 400);
  }
  await octokit.rest.issues.setLabels({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    labels: labels.concat(targetIntegration.label),
  });
}

const QUICK_TASK_LABEL = 'intake:quick-task';
const QUICK_TASK_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const QUICK_TASK_RECENT_ISSUE_LIMIT = 100;
const QUICK_TASK_CLAIM_REF_PREFIX = 'tags/agent-lcars/quick-task/';
const QUICK_TASK_CLAIM_TAG_PREFIX = 'agent-lcars/quick-task/';
const QUICK_TASK_CLAIM_MESSAGE_PREFIX = 'agent-lcars:quick-task-claim:v1 ';
// Kept exported from this long-standing module for callers/tests while the
// client-safe implementation also powers the exact issue preview.
export { deriveQuickTaskTitle } from './quick-task-evidence';

interface NormalizedQuickTaskRequest extends QuickTaskRequest {
  repository: WatchedRepo;
  title: string;
}

interface ExistingQuickTaskIssue {
  number: number;
  body?: string | null;
  pull_request?: unknown;
}

interface QuickTaskClaim {
  requestId: string;
  digest: string;
  claimantId: string;
}

function normalizeQuickTaskRequest(
  request: QuickTaskRequest & { repository: WatchedRepo },
): NormalizedQuickTaskRequest {
  const trimmed = request.description.trim();
  if (!trimmed) {
    throw new ActionError('Task description is required', 400);
  }
  if (!QUICK_TASK_REQUEST_ID_PATTERN.test(request.requestId)) {
    throw new ActionError('A valid Quick Task request ID is required', 400);
  }
  return {
    ...request,
    description: trimmed,
    title: deriveQuickTaskTitle(trimmed),
  };
}

const sha256Hex = (input: string): string =>
  createHash('sha256').update(input).digest('hex');

function quickTaskDigest(request: NormalizedQuickTaskRequest): string {
  return sharedQuickTaskDigest(
    {
      repository: repoKey(request.repository),
      pipeline: request.pipeline,
      title: request.title,
      description: request.description,
    },
    sha256Hex,
  );
}

function quickTaskClaimRef(requestId: string): string {
  return `${QUICK_TASK_CLAIM_REF_PREFIX}${requestId}`;
}

function quickTaskClaimMessage(
  requestId: string,
  digest: string,
  claimantId: string,
): string {
  return `${QUICK_TASK_CLAIM_MESSAGE_PREFIX}${JSON.stringify({ requestId, digest, claimantId })}`;
}

function parseQuickTaskClaim(message: string): QuickTaskClaim {
  if (!message.startsWith(QUICK_TASK_CLAIM_MESSAGE_PREFIX)) {
    throw new ActionError(
      'Quick Task claim is malformed; manual reconciliation is required',
      409,
    );
  }
  try {
    const value = JSON.parse(
      message.slice(QUICK_TASK_CLAIM_MESSAGE_PREFIX.length),
    ) as Record<string, unknown>;
    if (
      typeof value['requestId'] !== 'string' ||
      !QUICK_TASK_REQUEST_ID_PATTERN.test(value['requestId']) ||
      typeof value['digest'] !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(value['digest']) ||
      typeof value['claimantId'] !== 'string' ||
      !QUICK_TASK_REQUEST_ID_PATTERN.test(value['claimantId'])
    ) {
      throw new Error('invalid claim fields');
    }
    return {
      requestId: value['requestId'],
      digest: value['digest'],
      claimantId: value['claimantId'],
    };
  } catch (error) {
    if (error instanceof ActionError) throw error;
    throw new ActionError(
      'Quick Task claim is malformed; manual reconciliation is required',
      409,
    );
  }
}

function markerDigest(body: string | null | undefined, requestId: string) {
  if (!body) return undefined;
  // Multiple markers can appear in one body (e.g. a PR quoting/copying a
  // Quick Task issue's body) so every match must be scanned for the one
  // whose id matches, not just the first -- this needs the global matcher,
  // not `parseQuickTaskMarker`'s single-match semantics.
  for (const match of body.matchAll(quickTaskMarkerMatcher())) {
    if (match[1] === requestId) return match[2];
  }
  return undefined;
}

function receiptFor(
  request: NormalizedQuickTaskRequest,
  issueNumber: number,
): QuickTaskReceipt {
  const task = {
    repository: {
      owner: request.repository.owner,
      name: request.repository.name,
    },
    issueNumber,
  };
  return {
    requestId: request.requestId,
    task,
    url: taskRefUrl(task),
  };
}

function resolveExistingQuickTask(
  request: NormalizedQuickTaskRequest,
  digest: string,
  issues: ExistingQuickTaskIssue[],
): QuickTaskReceipt | undefined {
  const matches = issues.flatMap((issue) => {
    // GitHub's issues listing includes pull requests. A PR may quote/copy a
    // Quick Task body, but it can never be the canonical intake issue.
    if (issue.pull_request !== undefined) return [];
    const persistedDigest = markerDigest(issue.body, request.requestId);
    return persistedDigest ? [{ issue, persistedDigest }] : [];
  });
  if (matches.length === 0) return undefined;
  if (matches.some(({ persistedDigest }) => persistedDigest !== digest)) {
    throw new ActionError(
      'Quick Task request ID was already used for different task content',
      409,
    );
  }
  if (matches.length > 1) {
    throw new ActionError(
      'Quick Task request ID is attached to multiple issues; manual reconciliation is required',
      409,
    );
  }
  return receiptFor(request, matches[0].issue.number);
}

async function findExistingQuickTask(
  request: NormalizedQuickTaskRequest,
  digest: string,
): Promise<QuickTaskReceipt | undefined> {
  const octokit = getGithubClient();
  const { data: recent } = await octokit.rest.issues.listForRepo({
    owner: request.repository.owner,
    repo: request.repository.name,
    state: 'all',
    sort: 'created',
    direction: 'desc',
    per_page: QUICK_TASK_RECENT_ISSUE_LIMIT,
  });
  const recentMatch = resolveExistingQuickTask(request, digest, recent);
  if (recentMatch || recent.length < QUICK_TASK_RECENT_ISSUE_LIMIT) {
    return recentMatch;
  }

  // The direct issue list is preferable for a just-created issue because it
  // does not depend on search indexing. Search is only needed for a retry old
  // enough to have fallen beyond the recent window.
  const { data: search } = await octokit.rest.search.issuesAndPullRequests({
    q: `"agent-lcars:quick-task-request:v1 id=${request.requestId}" in:body repo:${repoKey(request.repository)} is:issue`,
    per_page: 10,
  });
  return resolveExistingQuickTask(request, digest, search.items);
}

function isDefinitiveCreateFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  // A 408 can be returned after the upstream request was accepted but before
  // its response reached us. Releasing the claim in that case would reopen
  // the duplicate-create race before the issue marker becomes visible.
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 408
  );
}

function githubStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function isRetryableGithubFailure(error: unknown): boolean {
  const status = githubStatus(error);
  return (
    status === undefined ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500
  );
}

async function readQuickTaskClaim(
  request: NormalizedQuickTaskRequest,
): Promise<QuickTaskClaim | undefined> {
  const octokit = getGithubClient();
  const ref = await (async () => {
    try {
      return (
        await octokit.rest.git.getRef({
          owner: request.repository.owner,
          repo: request.repository.name,
          ref: quickTaskClaimRef(request.requestId),
        })
      ).data;
    } catch (error) {
      if (githubStatus(error) === 404) return undefined;
      throw error;
    }
  })();
  if (!ref) return undefined;
  if (ref.object.type !== 'tag') {
    throw new ActionError(
      'Quick Task claim points to an unexpected Git object; manual reconciliation is required',
      409,
    );
  }
  const { data: tag } = await octokit.rest.git.getTag({
    owner: request.repository.owner,
    repo: request.repository.name,
    tag_sha: ref.object.sha,
  });
  return parseQuickTaskClaim(tag.message);
}

async function reconcileQuickTaskClaimAfterWrite(
  request: NormalizedQuickTaskRequest,
  { retryNotFound = true }: { retryNotFound?: boolean } = {},
): Promise<QuickTaskClaim | undefined> {
  // A successful ref write can briefly be absent from a following read, and
  // either request can lose its response. Give GitHub a bounded propagation
  // window before deciding that ownership cannot be established.
  const delaysMs = [0, 100, 300, 700, 1500];
  let successfulRead = false;
  let lastError: unknown;
  for (const delayMs of delaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const claim = await readQuickTaskClaim(request);
      successfulRead = true;
      if (claim) return claim;
      if (!retryNotFound) return undefined;
    } catch (error) {
      if (!isRetryableGithubFailure(error)) throw error;
      lastError = error;
    }
  }
  if (!successfulRead && lastError) throw lastError;
  return undefined;
}

function assertMatchingQuickTaskClaim(
  request: NormalizedQuickTaskRequest,
  digest: string,
  claim: QuickTaskClaim,
): void {
  if (claim.requestId !== request.requestId || claim.digest !== digest) {
    throw new ActionError(
      'Quick Task request ID was already used for different task content',
      409,
    );
  }
}

async function createQuickTaskClaim(
  request: NormalizedQuickTaskRequest,
  digest: string,
): Promise<{ state: 'acquired'; claimantId: string } | { state: 'existing' }> {
  const current = await readQuickTaskClaim(request);
  if (current) {
    assertMatchingQuickTaskClaim(request, digest, current);
    return { state: 'existing' };
  }

  const octokit = getGithubClient();
  const claimantId = randomUUID();
  const { data: repository } = await octokit.rest.repos.get({
    owner: request.repository.owner,
    repo: request.repository.name,
  });
  const { data: baseRef } = await octokit.rest.git.getRef({
    owner: request.repository.owner,
    repo: request.repository.name,
    ref: `heads/${repository.default_branch}`,
  });
  const { data: tag } = await octokit.rest.git.createTag({
    owner: request.repository.owner,
    repo: request.repository.name,
    tag: `${QUICK_TASK_CLAIM_TAG_PREFIX}${request.requestId}`,
    message: quickTaskClaimMessage(request.requestId, digest, claimantId),
    object: baseRef.object.sha,
    type: 'commit',
  });

  try {
    await octokit.rest.git.createRef({
      owner: request.repository.owner,
      repo: request.repository.name,
      ref: `refs/${quickTaskClaimRef(request.requestId)}`,
      sha: tag.sha,
    });
    return { state: 'acquired', claimantId };
  } catch (error) {
    // Creating the annotated tag object is harmless; the reference is the
    // atomic uniqueness boundary. A competing revision may have won between
    // our initial read and this write, so always reconcile the canonical ref
    // before deciding whether the createRef failure is actionable.
    const winner = await reconcileQuickTaskClaimAfterWrite(request);
    if (!winner) throw error;
    assertMatchingQuickTaskClaim(request, digest, winner);
    // GitHub may commit our ref and then lose the response. The per-attempt
    // claimant UUID makes ownership unambiguous even if two annotated tag
    // objects would otherwise have identical content/SHA.
    return winner.claimantId === claimantId
      ? { state: 'acquired', claimantId }
      : { state: 'existing' };
  }
}

async function releaseQuickTaskClaim(
  request: NormalizedQuickTaskRequest,
  digest: string,
  claimantId: string,
): Promise<void> {
  const attempts = 3;
  let claimWasObserved = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let current: QuickTaskClaim | undefined;
    try {
      current = await reconcileQuickTaskClaimAfterWrite(request, {
        // Before the first successful read, a 404 can still be propagation
        // lag from the just-created ref. After ownership has been observed,
        // a 404 following a failed delete proves our claim is gone.
        retryNotFound: !claimWasObserved,
      });
    } catch {
      throw new ActionError(
        'Quick Task issue creation failed and its claim could not be reconciled; manual reconciliation is required',
        409,
      );
    }
    if (!current) return;
    claimWasObserved = true;
    // A mismatched claim is an invariant violation, not a transient read
    // failure. Never delete a claim we cannot identify.
    assertMatchingQuickTaskClaim(request, digest, current);
    // Verify ownership before every delete. Our previous deletion may have
    // succeeded before its response was lost, followed by another invocation
    // acquiring a replacement claim.
    if (current.claimantId !== claimantId) return;

    try {
      await getGithubClient().rest.git.deleteRef({
        owner: request.repository.owner,
        repo: request.repository.name,
        ref: quickTaskClaimRef(request.requestId),
      });
      return;
    } catch (error) {
      if (githubStatus(error) === 404) return;
      if (!isRetryableGithubFailure(error)) {
        throw new ActionError(
          'Quick Task issue creation failed and its claim could not be released; manual reconciliation is required',
          409,
        );
      }
    }
  }

  // The final delete can also have committed before losing its response.
  let remaining: QuickTaskClaim | undefined;
  try {
    remaining = await reconcileQuickTaskClaimAfterWrite(request, {
      // Every path to this final check has already observed our claim.
      retryNotFound: false,
    });
  } catch {
    throw new ActionError(
      'Quick Task issue creation failed and its claim could not be reconciled; manual reconciliation is required',
      409,
    );
  }
  if (!remaining) return;
  assertMatchingQuickTaskClaim(request, digest, remaining);
  if (remaining.claimantId !== claimantId) return;
  throw new ActionError(
    'Quick Task issue creation failed and its claim could not be released; manual reconciliation is required',
    409,
  );
}

async function createQuickTaskOnce(
  request: NormalizedQuickTaskRequest,
  digest: string,
): Promise<QuickTaskReceipt> {
  const integration = requireAgentIntegration(
    request.repository,
    request.pipeline,
  );
  const existing = await findExistingQuickTask(request, digest);
  if (existing) return existing;

  const claim = await createQuickTaskClaim(request, digest);
  if (claim.state === 'existing') {
    // The winner may have created the issue after our initial marker scan but
    // before our claim-ref write lost. Reconcile once more before failing
    // closed so this overlapping request can return the canonical receipt.
    const winner = await findExistingQuickTask(request, digest);
    if (winner) return winner;
    // The other claimant may still be inside GitHub's issue-create request.
    // Never race it. The browser retains the request UUID, so a later retry
    // will discover its marker or return this same fail-closed result.
    throw new ActionError(
      'Quick Task creation is already claimed but no issue is visible yet; retry to reconcile it',
      409,
    );
  }

  const octokit = getGithubClient();
  try {
    const { data: issue } = await octokit.rest.issues.create({
      owner: request.repository.owner,
      repo: request.repository.name,
      title: request.title,
      body: `${request.description}\n\n${formatQuickTaskMarker({ requestId: request.requestId, digest })}`,
      labels: [QUICK_TASK_LABEL, integration.label],
    });
    return receiptFor(request, issue.number);
  } catch (error) {
    if (isDefinitiveCreateFailure(error)) {
      // A 4xx proves GitHub did not create the issue, so releasing the claim
      // is safe and lets the same browser intent retry after the validation,
      // permission, or label problem is corrected.
      await releaseQuickTaskClaim(request, digest, claim.claimantId);
      throw error;
    }

    // A transport timeout can happen after GitHub committed the issue but
    // before the response reached us. Re-read the marker before surfacing the
    // error so a retry returns the original canonical task instead of creating
    // another one.
    const recovered = await findExistingQuickTask(request, digest);
    if (recovered) return recovered;
    // Keep the atomic claim on any ambiguous failure. It may represent an
    // issue GitHub committed after our reconciliation read; deleting it here
    // would turn a harmless retry into a duplicate. A later retry rechecks
    // the marker, while a truly stranded claim is reconciled manually.
    throw error;
  }
}

const inFlightQuickTasks = new Map<
  string,
  { digest: string; promise: Promise<QuickTaskReceipt> }
>();

export function createQuickTask(
  rawRequest: QuickTaskRequest & { repository: WatchedRepo },
): Promise<QuickTaskReceipt> {
  const request = normalizeQuickTaskRequest(rawRequest);
  const digest = quickTaskDigest(request);
  const key = `${repoKey(request.repository)}:${request.requestId}`;
  const pending = inFlightQuickTasks.get(key);
  if (pending) {
    if (pending.digest !== digest) {
      return Promise.reject(
        new ActionError(
          'Quick Task request ID is already in flight with different task content',
          409,
        ),
      );
    }
    return pending.promise;
  }

  const promise = createQuickTaskOnce(request, digest);
  inFlightQuickTasks.set(key, { digest, promise });
  const cleanup = () => {
    if (inFlightQuickTasks.get(key)?.promise === promise) {
      inFlightQuickTasks.delete(key);
    }
  };
  void promise.then(cleanup, cleanup);
  return promise;
}
