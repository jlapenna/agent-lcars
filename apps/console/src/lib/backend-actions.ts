import { createHash, randomUUID } from 'node:crypto';

import {
  formatQuickTaskMarker,
  parseTerminalQuickTaskBody,
  quickTaskDigest as sharedQuickTaskDigest,
} from '@agent-lcars/dispatch-contracts';
import { logger } from '@agent-lcars/logging';
import { workPayloadSchema } from '@agent-lcars/work';

import { refreshCurrentGithubAnchorProjection } from './github-anchor-refresh';
import { REPO_HEADER } from './github-app-tokens';
import { getGithubClient, type WatchedRepo } from './github-client';
import { admitGithubWork } from './github-work-admission';
import { handleReconcile } from './orchestrator-routes';
import { createOrchestratorRuntime } from './orchestrator-runtime';
import { type Pipeline } from './primary-action';
import {
  agentIntegration,
  matchingAgentPipelines,
  repoKey,
  selectedReplyPipeline,
  supportedAgentPipelines,
} from './watched-repo';
import { workPayloadFromGithub } from './work-from-github';

const sha256Hex = (input: string): string =>
  createHash('sha256').update(input).digest('hex');

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
      logger.error(
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

/**
 * What a console reply actually did, so the caller can say so instead of
 * reporting a uniform success. `dispatched: false` is the ordinary,
 * non-error outcome for a comment on an item no agent owns - the case that
 * used to be indistinguishable from a real handoff (#1869).
 */
export interface PostCommentResult {
  url: string;
  dispatched: boolean;
  dispatchWarning?: AssignPipelineWarning;
}

export type AssignPipelineWarning =
  'dispatch-failed' | 'assignment-update-failed' | 'projection-refresh-failed';

export interface AssignPipelineResult {
  dispatched: true;
  warning?: AssignPipelineWarning;
}

export async function postComment(
  repo: WatchedRepo,
  issueNumber: number,
  body: string,
  actorLogin: string,
  assignedPipeline?: Pipeline,
): Promise<PostCommentResult> {
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
  let dispatchWarning: AssignPipelineWarning | undefined;
  try {
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
      const runtime = createOrchestratorRuntime();
      const taskId = { repo: repoKey(repo), issue: issueNumber };
      const existingTask = await runtime.store.readTask(taskId);
      // Nothing owns this item yet, and the caller explicitly chose who should.
      // `derivePrimaryAction` prescribes `reply` for every `status:needs-human`
      // item, but an item can be needs-human with no `agent:*` label at all -
      // and before #1869 that reply posted a comment, dispatched nobody, and
      // still reported success, so the queue kept prescribing the same dead end
      // (jlapenna/homelab#855). Treat the choice as the handoff it is:
      // `assignPipeline` labels the issue and admits `mode: 'implement'`. The
      // comment is already on the thread above, so the agent starts with the
      // steer that prompted it.
      //
      // `existingTask === undefined` is load-bearing, not belt-and-braces: Work
      // is immutable and written once per anchor, so an already-admitted task
      // whose label was removed by hand must keep degrading to a plain comment
      // (the `work.spec.pipeline` check below says the same thing for the
      // assigned case). Without it `assignPipeline` throws its 409 and a reply
      // that used to post silently would start failing outright.
      if (
        currentAssignment === undefined &&
        existingTask === undefined &&
        !issue.pull_request &&
        matchingAgentPipelines(repo, currentLabels).length === 0
      ) {
        const assignment = await assignPipeline(
          repo,
          issueNumber,
          assignedPipeline,
          actorLogin,
        );
        handedBackToAgent = assignment.dispatched;
        dispatchWarning = assignment.warning;
        await clearNeedsHumanLabel(repo, issueNumber);
        return {
          url: data.html_url,
          dispatched: handedBackToAgent,
          ...(dispatchWarning === undefined ? {} : { dispatchWarning }),
        };
      }
      if (currentAssignment !== assignedPipeline) {
        return { url: data.html_url, dispatched: false };
      }
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
          return { url: data.html_url, dispatched: false };
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
    return { url: data.html_url, dispatched: handedBackToAgent };
  } catch {
    // GitHub already accepted the comment. Every later read, admission, and
    // cleanup failure is therefore a partial success: tell the client to
    // clear its input and never invite a duplicate comment. Preserve whether
    // Work admission completed before the failure.
    return {
      url: data.html_url,
      dispatched: handedBackToAgent,
      dispatchWarning:
        dispatchWarning ??
        (handedBackToAgent ? 'projection-refresh-failed' : 'dispatch-failed'),
    };
  }
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
      logger.error(
        'agent-lcars: orchestrator reconcile sweep failed after #%s:',
        anchor,
        result.body,
      );
    }
  } catch (error) {
    logger.error(
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
): Promise<AssignPipelineResult> {
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
  try {
    await octokit.rest.issues.setLabels({
      owner: repo.owner,
      repo: repo.name,
      issue_number: issueNumber,
      labels: labels
        .filter((label) => label !== 'status:ready-for-agent')
        .concat(targetIntegration.label),
    });
  } catch {
    // Work admission is authoritative and already durable. Preserve that
    // successful dispatch even if its GitHub assignment projection cannot be
    // updated; retrying admission would only conflict with immutable Work.
    return { dispatched: true, warning: 'assignment-update-failed' };
  }
  try {
    await refreshGithubMutation(repo, issueNumber);
  } catch {
    // The label write succeeded and its webhook can refresh the projection.
    // Do not turn two durable successes into an apparent total failure.
    return { dispatched: true, warning: 'projection-refresh-failed' };
  }
  return { dispatched: true };
}
