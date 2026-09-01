import { createHash, randomUUID } from 'node:crypto';

import {
  formatQuickTaskMarker,
  parseTerminalQuickTaskBody,
  quickTaskDigest as sharedQuickTaskDigest,
  quickTaskMarkerMatcher,
} from '@agent-lcars/dispatch-contracts';
import { workPayloadSchema } from '@agent-lcars/work';

import { refreshCurrentGithubAnchorProjection } from './github-anchor-refresh';
import { REPO_HEADER } from './github-app-tokens';
import { getGithubClient, type WatchedRepo } from './github-client';
import { admitGithubWork } from './github-work-admission';
import { handleReconcile } from './orchestrator-routes';
import { createOrchestratorRuntime } from './orchestrator-runtime';
import { type Pipeline } from './primary-action';
import type { QuickTaskReceipt, QuickTaskRequest } from './quick-task-contract';
import { deriveQuickTaskTitle } from './quick-task-evidence';
import type {
  QuickTaskEvidenceIntent,
  QuickTaskEvidenceObject,
  QuickTaskEvidencePreIssueCreateHook,
} from './quick-task-evidence-contract';
import {
  agentIntegration,
  repoKey,
  selectedReplyPipeline,
  supportedAgentPipelines,
  taskRefUrl,
} from './watched-repo';
import { workPayloadFromGithub } from './work-from-github';

export class ActionError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'ActionError';
  }
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

/** Console writes receive the authoritative GitHub mutation response before
 * the asynchronous webhook. Refresh the same durable projection that the
 * webhook owns so the following render observes that write; this is an exact
 * control-plane read, not a render-time compatibility lookup. */
async function refreshGithubMutation(
  repo: WatchedRepo,
  issueNumber: number,
): Promise<void> {
  await refreshCurrentGithubAnchorProjection({
    repo: repoKey(repo),
    issue: issueNumber,
  });
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
    // failed outright) - nothing changed for the orchestrator to catch up
    // on.
    return;
  }
  await refreshGithubMutation(repo, issueNumber);
  // A label write is invisible to the orchestrator (it tracks no GitHub
  // label state at all - see model.ts), but it may be running behind on an
  // unrelated expired lease. Catch it up now rather than waiting on the
  // next scheduled sweep (dispatch-reconcile.yml).
  await notifyReconcile(issueNumber);
}

export async function postComment(
  repo: WatchedRepo,
  issueNumber: number,
  body: string,
  actorLogin: string,
  assignedPipeline?: Pipeline,
): Promise<{ url: string }> {
  if (!body.trim()) {
    throw new ActionError('Comment body is required', 400);
  }
  if (!actorLogin.trim()) {
    throw new ActionError('Comment actor is required', 400);
  }
  // Validate an explicit dispatch choice before creating any GitHub-side
  // comment. The UI only supplies canonical selections, but Server Action
  // arguments are still untrusted at the network boundary.
  if (assignedPipeline !== undefined) {
    requireAgentIntegration(repo, assignedPipeline);
  }
  const octokit = getGithubClient();
  const { data } = await octokit.rest.issues.createComment({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    body,
  });
  // The inbox projection's exactly-one canonical agent label is the explicit
  // console intent to hand this comment to an agent. A Task alone is not that
  // signal: Work can remain after somebody removes an assignment label, and
  // comments on that now-unassigned item must stay ordinary human comments.
  // The immutable Task Work still supplies the authoritative target once the
  // caller has made that explicit choice.
  let handedBackToAgent = false;
  if (assignedPipeline !== undefined) {
    // A card's labels are only a render-time projection. Re-read the current
    // GitHub labels at the dispatch boundary so a removed, changed, or
    // contradictory assignment cannot be revived by a stale/crafted Server
    // Action argument. `selectedReplyPipeline` accepts exactly one canonical
    // agent:* target (or review:* target for a PR) and has no repo/provider-
    // specific precedence.
    const { data: issue } = await octokit.rest.issues.get({
      owner: repo.owner,
      repo: repo.name,
      issue_number: issueNumber,
    });
    const currentLabels = issue.labels.map((label) =>
      typeof label === 'string' ? label : (label.name ?? ''),
    );
    const currentAssignment = selectedReplyPipeline(
      repo,
      currentLabels,
      issue.pull_request ? 'pr' : 'issue',
    );
    if (currentAssignment !== assignedPipeline) {
      return { url: data.html_url };
    }
    const runtime = createOrchestratorRuntime();
    const taskId = { repo: repoKey(repo), issue: issueNumber };
    const existingTask = await runtime.store.readTask(taskId);
    // A label can be visible before its webhook admission reaches the
    // control plane. Preserve the comment in that transient state; the
    // webhook remains responsible for first Work admission.
    if (existingTask !== undefined) {
      const work = workPayloadSchema.parse(existingTask.task.work);
      // Assignment labels are an explicit present-tense handoff, whereas
      // Work's pipeline is immutable. A rejected label-change webhook can
      // therefore leave a new label beside older Work. Do not revive that
      // older Work on a reply: all three sources must agree before a run can
      // begin or the human handoff can be cleared.
      if (work.spec.pipeline !== assignedPipeline) {
        return { url: data.html_url };
      }
      const outcome = await admitGithubWork(runtime, {
        anchor: taskId,
        requestId: `console-reply:${randomUUID()}`,
        params: { mode: 'reply', reply: body },
        work,
      });
      if (outcome.kind === 'busy') {
        throw new ActionError('A run is already active for this task', 409);
      }
      if (outcome.kind !== 'accepted') {
        throw new ActionError(`Reply dispatch was ${outcome.kind}`, 409);
      }
      handedBackToAgent = true;
    }
  }
  // `status:needs-human` is the agent-to-human handoff. Clearing it is only
  // correct after this comment actually began a new agent run; a plain
  // comment on an unassigned item must leave that human-work signal intact.
  if (handedBackToAgent) {
    await clearNeedsHumanLabel(repo, issueNumber);
  }
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
  await refreshGithubMutation(repo, prNumber);

  // The orchestrator has no notion of a merged PR either (#1183 - see
  // model.ts). What still helps is catching up any unrelated run whose
  // lease has already silently expired, same as every other mutation below
  // that used to ping the legacy controller - do it now instead of waiting
  // on dispatch-reconcile.yml's next scheduled sweep.
  await notifyReconcile(prNumber);
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
  await refreshGithubMutation(repo, prNumber);
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
  //
  // This mutation is keyed entirely by `pr.node_id` (an opaque GraphQL node
  // id) - unlike every other GitHub call in this file, no owner/repo
  // parameter or variable names the target repo, so getGithubClient()'s
  // per-request auth routing (github-app-tokens.ts's
  // `resolveRequestRepo`) cannot recover it structurally. The REPO_HEADER
  // header is the documented escape hatch for exactly this case.
  await octokit.graphql(ENABLE_AUTO_MERGE_MUTATION, {
    pullRequestId: pr.node_id,
    mergeMethod: 'SQUASH',
    headers: { [REPO_HEADER]: repoKey(repo) },
  });
  await refreshGithubMutation(repo, prNumber);
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
  await refreshGithubMutation(repo, issueNumber);
  // The orchestrator tracks no GitHub issue-state field at all (#1183 - see
  // model.ts's doc comment: a durable per-task mutex, not a projection of
  // GitHub state), so this close does not change anything it needs to
  // learn about. It may still be running behind on an unrelated expired
  // lease elsewhere, though - catch it up now rather than waiting on the
  // next scheduled sweep (dispatch-reconcile.yml).
  await notifyReconcile(issueNumber);
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
  await refreshGithubMutation(repo, issueNumber);
}

const DISPATCH_CALLER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// After a console action mutates a GitHub-side fact (a park-state label, an
// issue close, or a merge), catch the orchestrator up
// immediately rather than only on dispatch-reconcile.yml's next scheduled
// sweep (up to ~30 minutes later - see that workflow's cron). #1183: unlike
// the legacy dispatch controller this replaced, the orchestrator tracks no
// GitHub-side state to reconcile *toward* (see model.ts's doc comment - a
// durable per-task mutex over runs, not a projection of issue/PR fields), so
// there is no anchor-scoped "reconcile #N" operation left to call. Sweeping
// every expired lease and draining the outbox is the actual mechanism the
// scheduled sweep itself runs (`orchestrator-routes.ts`'s `handleReconcile`,
// invoked by `/api/control-plane/reconcile`); reusing it here just runs that
// same catch-up early instead of waiting for the next tick.
//
// The mutation this follows has already landed on GitHub by the time this
// runs, so any failure here is logged and swallowed rather than surfaced to
// the caller - a red toast over a best-effort follow-up sweep would be a
// worse bug than the latency this exists to shrink; the scheduled sweep
// remains the backstop either way.
//
// `anchor` is only ever an issue/PR number log-line label; the actual sweep
// below is anchor-agnostic (see the #1183 comment above).
async function notifyReconcile(anchor: number | string): Promise<void> {
  try {
    const result = await handleReconcile(createOrchestratorRuntime());
    if (result.status !== 200) {
      console.error(
        'agent-lcars: orchestrator reconcile sweep failed after #%s:',
        anchor,
        result.body,
      );
    }
  } catch (error) {
    console.error(
      'agent-lcars: failed to sweep the orchestrator after #%s:',
      anchor,
      error,
    );
  }
}

// dispatchUnstickPrs is console-level ops, but its repository is always
// explicit. There is no primary-repository substitution.
export async function dispatchUnstickPrs(
  context: string | undefined,
  repo: WatchedRepo,
  actorLogin?: string,
): Promise<void> {
  const targetRepo = repo;
  if (!actorLogin?.trim()) {
    throw new ActionError('Unstick actor is required', 400);
  }
  const octokit = getGithubClient();
  const trimmedContext = context?.trim();
  const { data: openAnchors } = await octokit.rest.issues.listForRepo({
    owner: targetRepo.owner,
    repo: targetRepo.name,
    state: 'open',
    labels: 'automation:unstick-prs',
    per_page: 1,
  });
  let anchor = openAnchors.find((item) => item.pull_request === undefined);
  if (anchor) {
    await octokit.rest.issues.createComment({
      owner: targetRepo.owner,
      repo: targetRepo.name,
      issue_number: anchor.number,
      body: `Re-dispatched by @${actorLogin}. Context: ${trimmedContext || '(none)'}`,
    });
  } else {
    const { data: created } = await octokit.rest.issues.create({
      owner: targetRepo.owner,
      repo: targetRepo.name,
      title: `playbook: unstick stuck PRs (${new Date().toISOString().slice(0, 10)})`,
      labels: ['automation:unstick-prs'],
      body:
        `Dispatched by @${actorLogin} through the Agent LCARS Work API.\n\n` +
        `Context: ${trimmedContext || '(none)'}\n\n` +
        'Execute the unsticking-stuck-prs runbook and keep the per-PR summary here.',
    });
    anchor = created;
  }
  const description =
    anchor.body?.trim() || 'Unstick the current pull-request queue.';
  const runtime = createOrchestratorRuntime();
  const outcome = await admitGithubWork(runtime, {
    anchor: { repo: repoKey(targetRepo), issue: anchor.number },
    requestId: `console-unstick:${randomUUID()}`,
    params: {
      mode: 'implement',
      reply:
        'Post the queue diagnosis, actions taken, and remaining blockers on this issue.',
      runbook: 'unsticking-stuck-prs',
      context: trimmedContext ?? '',
    },
    work: workPayloadFromGithub({
      title: anchor.title,
      body: description,
      pipeline: 'claude',
      repo: repoKey(targetRepo),
      actor: actorLogin,
    }),
  });
  if (outcome.kind === 'busy') {
    throw new ActionError('The unstick runbook is already active', 409);
  }
  if (outcome.kind !== 'accepted') {
    throw new ActionError(`Unstick dispatch was ${outcome.kind}`, 409);
  }
}

/**
 * Re-requests work on a task through the orchestrator (#1183): unlike the
 * legacy broker's label-driven admission, the orchestrator's `request()` is
 * the one dispatch entry point, keyed by the clicked item's own `TaskId`.
 * The repository is part of task identity, so a Retry click must preserve the
 * watched repository rather than collapsing every item onto the controller's
 * home repository. A Retry click always mints a fresh idempotency key: unlike
 * a webhook replay, there is no meaningful "same request" to converge on.
 */
export async function retriggerIssue(
  repo: WatchedRepo,
  issueNumber: number,
  callerId: string,
  note?: string,
): Promise<void> {
  if (!DISPATCH_CALLER_ID_PATTERN.test(callerId)) {
    throw new ActionError('A valid dispatch caller ID is required', 400);
  }

  const runtime = createOrchestratorRuntime();
  const { store } = runtime;
  const taskId = { repo: repoKey(repo), issue: issueNumber };
  const existingTask = await store.readTask(taskId);
  if (existingTask === undefined) {
    throw new ActionError(
      'No authoritative Work is recorded for this task; assign an agent before retrying',
      409,
    );
  }
  const existingWork = workPayloadSchema.parse(existingTask.task.work);

  await clearNeedsHumanLabel(repo, issueNumber);

  // A steering note goes up BEFORE the retrigger so the fresh run reads it
  // as part of the thread. Deliberately NOT run through ensureMention: a
  // comment already containing the pipeline's own mention dispatches a run
  // through the direct reply path, so dispatching here would double-run it.
  const trimmedNote = note?.trim();
  if (trimmedNote) {
    const octokit = getGithubClient();
    await octokit.rest.issues.createComment({
      owner: repo.owner,
      repo: repo.name,
      issue_number: issueNumber,
      body: trimmedNote,
    });
  }

  const outcome = await admitGithubWork(runtime, {
    anchor: taskId,
    requestId: `console-retry:${randomUUID()}`,
    params: { mode: 'implement' },
    work: existingWork,
  });
  if (outcome.kind === 'busy') {
    throw new ActionError('A run is already active for this task', 409);
  }
  if (outcome.kind !== 'accepted') {
    throw new ActionError('Retrigger could not be processed', 500);
  }
  return;
}

/** Assigns an unclaimed open issue to an agent pipeline. */
export async function assignPipeline(
  repo: WatchedRepo,
  issueNumber: number,
  targetPipeline: Pipeline,
  actorLogin: string,
): Promise<void> {
  const targetIntegration = requireAgentIntegration(repo, targetPipeline);
  const taskId = { repo: repoKey(repo), issue: issueNumber };
  const existingTask = await createOrchestratorRuntime().store.readTask(taskId);
  if (existingTask !== undefined) {
    // Work is written exactly once for every GitHub anchor. GitHub labels are
    // only a request signal, so a manually removed agent label must not make
    // the console recreate Reassign by relabeling an already-admitted task.
    // Validate the durable payload before relying on its immutable contract.
    workPayloadSchema.parse(existingTask.task.work);
    throw new ActionError(
      'Issue already has immutable Work; retry its admitted pipeline instead',
      409,
    );
  }

  const octokit = getGithubClient();
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
  const runtime = createOrchestratorRuntime();
  const outcome = await admitGithubWork(runtime, {
    anchor: taskId,
    requestId: `console-assign:${randomUUID()}`,
    params: { mode: 'implement' },
    work: workPayloadFromGithub({
      title: issue.title,
      body: issue.body,
      pipeline: targetPipeline,
      repo: repoKey(repo),
      actor: actorLogin,
    }),
  });
  if (outcome.kind === 'conflict') {
    throw new ActionError(outcome.message, 409);
  }
  if (outcome.kind !== 'accepted' && outcome.kind !== 'busy') {
    throw new ActionError(`Assignment dispatch was ${outcome.kind}`, 409);
  }
  // The primary production scenario for this action is a
  // `status:ready-for-agent` Inbox item: clear that handoff status in the
  // same write, or action-items.ts keeps classifying the now-dispatched
  // issue as ready-for-agent and it lingers in the maintainer queue with a
  // misleading reason even though an agent label is now present.
  await octokit.rest.issues.setLabels({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    labels: labels
      .filter((label) => label !== 'status:ready-for-agent')
      .concat(targetIntegration.label),
  });
  await refreshGithubMutation(repo, issueNumber);
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
  actorLogin: string;
}

interface ExistingQuickTaskIssue {
  number: number;
  title: string;
  body?: string | null;
  pull_request?: unknown;
}

interface QuickTaskIssueSource {
  number: number;
  title: string;
  body: string | null | undefined;
}

interface ExistingQuickTask {
  receipt: QuickTaskReceipt;
  source: QuickTaskIssueSource;
}

interface QuickTaskClaim {
  requestId: string;
  digest: string;
  claimantId: string;
}

type AppIssueCreate = ReturnType<
  typeof getGithubClient
>['rest']['issues']['create'];
export type QuickTaskIssueCreator = (
  parameters: NonNullable<Parameters<AppIssueCreate>[0]>,
) => ReturnType<AppIssueCreate>;

/**
 * Server-only evidence lifecycle. It is intentionally not part of the
 * browser's QuickTaskRequest because upload state never crosses the Server
 * Action boundary.
 */
export interface QuickTaskEvidenceLifecycle {
  intent: QuickTaskEvidenceIntent;
  hook: QuickTaskEvidencePreIssueCreateHook;
}

function normalizeQuickTaskRequest(
  request: QuickTaskRequest & { repository: WatchedRepo; actorLogin: string },
): NormalizedQuickTaskRequest {
  const trimmed = request.description.trim();
  if (!trimmed) {
    throw new ActionError('Task description is required', 400);
  }
  if (!QUICK_TASK_REQUEST_ID_PATTERN.test(request.requestId)) {
    throw new ActionError('A valid Quick Task request ID is required', 400);
  }
  if (!request.actorLogin.trim()) {
    throw new ActionError('Quick Task actor is required', 400);
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

function quickTaskBody(
  request: NormalizedQuickTaskRequest,
  digest: string,
): string {
  return `${request.description}\n\n${formatQuickTaskMarker({ requestId: request.requestId, digest })}`;
}

function validateStoredQuickTaskWork(
  request: NormalizedQuickTaskRequest,
  digest: string,
  issue: QuickTaskIssueSource,
  storedWork: unknown,
): void {
  if (markerDigest(issue.body, request.requestId) !== digest) {
    throw new ActionError(
      'Quick Task marker does not match its request; manual reconciliation is required',
      409,
    );
  }
  const work = workPayloadSchema.parse(storedWork);
  const expectedSpec = workPayloadFromGithub({
    title: request.title,
    body: quickTaskBody(request, digest),
    pipeline: request.pipeline,
    repo: repoKey(request.repository),
    actor: request.actorLogin,
  }).spec;
  // A webhook may be the first writer, so its concrete GitHub principal can
  // differ from the console actor. Its channel and every immutable spec field
  // must nevertheless be the exact Work described by this marker request.
  if (
    work.origin.channel !== 'github' ||
    work.spec.title !== expectedSpec.title ||
    work.spec.description !== expectedSpec.description ||
    work.spec.pipeline !== expectedSpec.pipeline ||
    work.spec.target.repo !== expectedSpec.target.repo
  ) {
    throw new ActionError(
      'Quick Task immutable Work does not match its marker request; manual reconciliation is required',
      409,
    );
  }
}

async function admitQuickTask(
  request: NormalizedQuickTaskRequest,
  digest: string,
  issue: QuickTaskIssueSource,
): Promise<void> {
  const runtime = createOrchestratorRuntime();
  const anchor = { repo: repoKey(request.repository), issue: issue.number };
  // A Quick Task marker is intentionally retained when the issue is edited.
  // A browser retry must therefore use the immutable Work that was admitted
  // for this anchor, not reconstruct a competing Work from the edited
  // GitHub title/body before its original request id can be recognized.
  const stored = await runtime.store.readTask(anchor);
  if (stored !== undefined) {
    validateStoredQuickTaskWork(request, digest, issue, stored.task.work);
    // The first writer (normally the label webhook) already created the
    // immutable Task. Do not turn a transient busy result into a second Run
    // after it settles: this marker request has reached its canonical result.
    return;
  }
  const work = workPayloadFromGithub({
    title: issue.title,
    body: issue.body,
    pipeline: request.pipeline,
    repo: repoKey(request.repository),
    actor: request.actorLogin,
  });
  const outcome = await admitGithubWork(runtime, {
    anchor,
    // The browser retains this UUID across retries. Reusing it here makes a
    // recovered issue-create response converge on the same Work request.
    requestId: `console-quick-task:${request.requestId}`,
    params: { mode: 'implement' },
    work,
  });
  if (
    outcome.kind === 'accepted' ||
    outcome.kind === 'duplicate' ||
    outcome.kind === 'busy'
  ) {
    return;
  }
  if (outcome.kind === 'conflict') {
    throw new ActionError(outcome.message, 409);
  }
  throw new ActionError(`Quick Task dispatch was ${outcome.kind}`, 409);
}

function resolveExistingQuickTask(
  request: NormalizedQuickTaskRequest,
  digest: string,
  issues: ExistingQuickTaskIssue[],
): ExistingQuickTask | undefined {
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
  const issue = matches[0].issue;
  return {
    receipt: receiptFor(request, issue.number),
    // listForRepo/search return the persisted GitHub representation. Using
    // it rather than reconstructing from the retry request ensures recovery
    // converges with a webhook that admitted this issue first.
    source: { number: issue.number, title: issue.title, body: issue.body },
  };
}

async function findExistingQuickTask(
  request: NormalizedQuickTaskRequest,
  digest: string,
): Promise<ExistingQuickTask | undefined> {
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
  //
  // The `repo:` qualifier above scopes results to this one repo (search
  // results are further bounded to whatever repos the request's own
  // installation token can see - see #1284's audit), but it lives inside
  // the free-text `q` string, not a structured `owner`/`repo` parameter -
  // getGithubClient()'s per-request auth routing cannot recover a repo from
  // that without re-parsing the query string, so the REPO_HEADER header
  // names it explicitly instead.
  const { data: search } = await octokit.rest.search.issuesAndPullRequests({
    q: `"agent-lcars:quick-task-request:v1 id=${request.requestId}" in:body repo:${repoKey(request.repository)} is:issue`,
    per_page: 10,
    headers: { [REPO_HEADER]: repoKey(request.repository) },
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
  evidenceLifecycle?: QuickTaskEvidenceLifecycle,
  issueCreator?: QuickTaskIssueCreator,
): Promise<QuickTaskReceipt> {
  const integration = requireAgentIntegration(
    request.repository,
    request.pipeline,
  );
  const existing = await findExistingQuickTask(request, digest);
  if (existing) {
    await admitQuickTask(request, digest, existing.source);
    return existing.receipt;
  }

  const claim = await createQuickTaskClaim(request, digest);
  if (claim.state === 'existing') {
    // The winner may have created the issue after our initial marker scan but
    // before our claim-ref write lost. Reconcile once more before failing
    // closed so this overlapping request can return the canonical receipt.
    const winner = await findExistingQuickTask(request, digest);
    if (winner) {
      await admitQuickTask(request, digest, winner.source);
      return winner.receipt;
    }
    // The other claimant may still be inside GitHub's issue-create request.
    // Never race it. The browser retains the request UUID, so a later retry
    // will discover its marker or return this same fail-closed result.
    throw new ActionError(
      'Quick Task creation is already claimed but no issue is visible yet; retry to reconcile it',
      409,
    );
  }

  const octokit = getGithubClient();
  let preparedEvidence: QuickTaskEvidenceObject | undefined;
  if (evidenceLifecycle) {
    try {
      const { data: repository } = await octokit.rest.repos.get({
        owner: request.repository.owner,
        repo: request.repository.name,
      });
      const visibility = repository.visibility;
      if (
        typeof repository.id !== 'number' ||
        (visibility !== 'public' &&
          visibility !== 'private' &&
          visibility !== 'internal')
      ) {
        throw new ActionError(
          'Quick Task evidence repository metadata is unavailable',
          503,
        );
      }
      preparedEvidence = await evidenceLifecycle.hook.prepare({
        intent: evidenceLifecycle.intent,
        repositoryId: repository.id,
        visibility,
      });
    } catch (error) {
      // Evidence preparation happens before issues.create, so no issue can
      // exist. Its adapter reconciles any ambiguous storage write; releasing
      // this durable claim lets the same browser intent retry afterwards.
      await releaseQuickTaskClaim(request, digest, claim.claimantId);
      throw error;
    }
  }

  try {
    const body = quickTaskBody(request, digest);
    const { data: issue } = await (
      issueCreator ?? ((parameters) => octokit.rest.issues.create(parameters))
    )({
      owner: request.repository.owner,
      repo: request.repository.name,
      title: request.title,
      body,
      labels: [QUICK_TASK_LABEL, integration.label],
    });
    // Admit before refreshing the read projection. The issue write above is
    // the durable source of truth, so this exact title/body is also what a
    // label webhook sees. Either ordering therefore records the same
    // immutable Work specification.
    await admitQuickTask(request, digest, {
      number: issue.number,
      title: request.title,
      body,
    });
    await refreshGithubMutation(request.repository, issue.number);
    return receiptFor(request, issue.number);
  } catch (error) {
    if (isDefinitiveCreateFailure(error)) {
      if (preparedEvidence && evidenceLifecycle) {
        await evidenceLifecycle.hook.rollbackDefinitiveCreateFailure(
          preparedEvidence,
        );
        // A definitive GitHub response proves this request did not create an
        // issue. Release the claim only after the generation-matched evidence
        // deletion succeeded; otherwise retain it for reconciliation instead
        // of stranding publicly retrievable bytes behind a fresh retry.
        await releaseQuickTaskClaim(request, digest, claim.claimantId);
        throw error;
      }
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
    if (recovered) {
      await admitQuickTask(request, digest, recovered.source);
      return recovered.receipt;
    }
    // Keep the atomic claim on any ambiguous failure. It may represent an
    // issue GitHub committed after our reconciliation read; deleting it here
    // would turn a harmless retry into a duplicate. A later retry rechecks
    // the marker, while a truly stranded claim is reconciled manually.
    throw error;
  }
}

const inFlightQuickTasks = new Map<
  string,
  {
    digest: string;
    evidenceLifecycle?: QuickTaskEvidenceLifecycle;
    promise: Promise<QuickTaskReceipt>;
  }
>();

export function createQuickTask(
  rawRequest: QuickTaskRequest & {
    repository: WatchedRepo;
    actorLogin: string;
  },
  evidenceLifecycle?: QuickTaskEvidenceLifecycle,
  issueCreator?: QuickTaskIssueCreator,
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
    // Evidence bytes are intentionally not in the durable issue
    // digest. A second HTTP request cannot prove it carries the same bytes as
    // an already-preparing upload, so never return that request the first
    // request's success. The multipart route may share this exact lifecycle
    // object for an in-process retry; every distinct request must wait and
    // reconcile through its own evidence binding instead.
    if (
      (evidenceLifecycle || pending.evidenceLifecycle) &&
      evidenceLifecycle !== pending.evidenceLifecycle
    ) {
      return Promise.reject(
        new ActionError(
          'Quick Task evidence is already in flight; retry to reconcile it',
          409,
        ),
      );
    }
    return pending.promise;
  }

  const promise = createQuickTaskOnce(
    request,
    digest,
    evidenceLifecycle,
    issueCreator,
  );
  inFlightQuickTasks.set(key, { digest, evidenceLifecycle, promise });
  const cleanup = () => {
    if (inFlightQuickTasks.get(key)?.promise === promise) {
      inFlightQuickTasks.delete(key);
    }
  };
  void promise.then(cleanup, cleanup);
  return promise;
}
