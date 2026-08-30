import { createHash, randomUUID } from 'node:crypto';

import {
  formatQuickTaskMarker,
  isDispatchPipeline,
  parseTerminalQuickTaskBody,
  quickTaskDigest as sharedQuickTaskDigest,
  quickTaskMarkerMatcher,
} from '@agent-lcars/dispatch-contracts';
import { isRefusal } from '@agent-lcars/orchestrator';
import { workIdFromIntentId } from '@agent-lcars/work';

import {
  attemptMarkerFromDisplayTitle,
  issueNumberFromDisplayTitle,
} from './agent-activity';
import { controlPlaneRepository } from './deployment';
import { REPO_HEADER } from './github-app-tokens';
import {
  getGithubClient,
  primaryWatchedRepo,
  type WatchedRepo,
} from './github-client';
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
import { matchReplyTrigger } from './reply-trigger';
import {
  type AgentIntegration,
  agentIntegration,
  repoKey,
  selectedAgentPipeline,
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

function replyTriggers(integration: AgentIntegration): string[] {
  return [integration.replyTrigger, ...(integration.replyTriggerAliases ?? [])];
}

function containsReplyTrigger(
  body: string,
  integration: AgentIntegration,
): boolean {
  return matchReplyTrigger(body, replyTriggers(integration)) !== undefined;
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
    // failed outright) - nothing changed for the orchestrator to catch up
    // on.
    return;
  }
  // A label write is invisible to the orchestrator (it tracks no GitHub
  // label state at all - see model.ts), but it may be running behind on an
  // unrelated expired lease. Catch it up now rather than waiting on the
  // next scheduled sweep (dispatch-reconcile.yml).
  await notifyReconcile(issueNumber);
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
  // The run just killed may be the task's own live orchestrator run -
  // reflect that into the orchestrator now rather than waiting out its
  // lease. cancelWorkflowRun's own signature carries no anchor number, so
  // notifyReconcileForCancelledRun looks one up from the run itself first.
  await notifyReconcileForCancelledRun(repo, runId);
}

const DEFAULT_BRANCH = 'main';
const DISPATCH_CALLER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// After a console action mutates a GitHub-side fact (a park-state label, an
// issue close, a merge, a cancelled workflow run), catch the orchestrator up
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
// `anchor` is only ever a log-line label here (an issue/PR number for a
// GitHub-anchored run, or a native orchestrator `runId` string for a
// dispatch:g<gen>:work:<ulid>/r<n> run) - the actual sweep below is anchor-
// agnostic (see the #1183 comment above).
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

// cancelWorkflowRun's own signature carries only a run id, not the
// issue/PR anchor closeIssue/approveAndMergePr's callers already supply -
// so the anchor is looked up from the run itself rather than threaded in.
// claude.yml/codex.yml/opencode.yml's `run-name` renders `#<N>: ...` into
// the run's `display_title`, the same field agent-activity.ts's
// issueNumberFromDisplayTitle already trusts to join a live run back to
// its issue for the dashboard. A native work item's run instead titles
// itself `native work: <label> [dispatch:g<gen>:work:<ulid>/r<n>]` - no
// leading `#<N>:` to parse, but its dispatch marker's `intentId` IS the
// orchestrator's own `runId`, so that is used as the anchor directly
// instead of an issue lookup (see `cancelAnchorFromDisplayTitle`). A run
// whose title carries neither shape (predates the run-name rollout, or was
// dispatched by hand outside the fleet) has no anchor this console can
// identify from the run alone - reflection and the sweep are both skipped
// for it and left to the scheduled sweep, the same "don't guess" posture
// approveAndMergePr takes for a merge's linked-issue anchor.
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
  let anchor: CancelAnchor | undefined;
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
      anchor ??= cancelAnchorFromDisplayTitle(run.display_title);
      if (run.status !== 'completed') continue;
    } catch (error) {
      console.error(
        'agent-lcars: failed to identify the anchor for cancelled run #%s:',
        runId,
        error,
      );
      return;
    }
    if (anchor !== undefined) {
      await reflectCancelledRunInOrchestrator(anchor);
      await notifyReconcile('issue' in anchor ? anchor.issue : anchor.runId);
    }
    return;
  }

  console.warn(
    'agent-lcars: cancelled run #%s did not become terminal before the reconcile wait expired; the scheduled sweep will converge it',
    runId,
  );
}

// The anchor a cancelled GitHub Actions run's display_title resolves to -
// either the issue/PR number a legacy dispatch worked, or the orchestrator's
// own runId for a native work item's dispatch (its intentId, verbatim -
// workIdFromIntentId only validates the `work:<ulid>/r<n>` shape, the
// intentId itself IS the runId store.readRun/orchestrator.cancel expect).
type CancelAnchor = { issue: number } | { runId: string };

function cancelAnchorFromDisplayTitle(
  displayTitle: string,
): CancelAnchor | undefined {
  const issue = issueNumberFromDisplayTitle(displayTitle);
  if (issue !== undefined) return { issue };
  const marker = attemptMarkerFromDisplayTitle(displayTitle);
  return marker && workIdFromIntentId(marker.intentId)
    ? { runId: marker.intentId }
    : undefined;
}

// cancelWorkflowRun's own GitHub Actions run id has no orchestrator
// equivalent recorded anywhere - a `Run` only ever carries the orchestrator's
// own minted `runId`, never a GitHub Actions numeric run id (see model.ts's
// runSchema). For an issue-anchored run, the anchor issue number resolved
// above is the only honest join available: if the control-plane task for
// that anchor currently has a live run, the orchestrator's own
// one-live-run-per-task invariant means that run can only be the one this
// GitHub Actions cancellation was acting on, so its lock is released now
// instead of waiting out its lease. A native work item's anchor is already
// the runId itself (its dispatch marker's intentId - see
// cancelAnchorFromDisplayTitle), so that case cancels directly without an
// issue lookup. When there is no live run to find (already settled, or was
// never one to begin with - e.g. a manually dispatched run outside the
// orchestrator), there is nothing to reflect; the mismatch is simply left
// alone, same "don't guess" posture as everywhere else in this file.
async function reflectCancelledRunInOrchestrator(
  anchor: CancelAnchor,
): Promise<void> {
  try {
    const { store, orchestrator } = createOrchestratorRuntime();
    const runId =
      'runId' in anchor
        ? anchor.runId
        : (
            await store.readActiveRun({
              repo: controlPlaneRepository(),
              issue: anchor.issue,
            })
          )?.runId;
    if (runId === undefined) return;
    // `cancel` only ever refuses `unknown-run`/`run-not-live` - both mean
    // the run already stopped being live between this read and the call,
    // which is exactly the outcome this reflection wants anyway (mirrors
    // reassignPipeline's identical guard elsewhere in this file).
    await orchestrator.cancel(runId, 'canceled from console');
  } catch (error) {
    console.error(
      'agent-lcars: failed to reflect the cancelled run into the orchestrator for %j:',
      anchor,
      error,
    );
  }
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

/** A Retry click always falls back to this pipeline when the orchestrator
 * has no prior run to read a pipeline from (a legacy-era task never worked
 * under `@agent-lcars/orchestrator`, or a task the fleet has never touched
 * at all). */
const RETRIGGER_FALLBACK_PIPELINE: Pipeline = 'claude';

export interface RetriggerOutcome {
  /** True when no prior orchestrator run existed for this task, so the
   * dispatch pipeline fell back to {@link RETRIGGER_FALLBACK_PIPELINE}
   * instead of reading the task's own history. */
  pipelineFallback: boolean;
}

/** The pipeline of a task's most recently created orchestrator run, or
 * `undefined` when the task has no run history yet (see
 * {@link RETRIGGER_FALLBACK_PIPELINE}). Falls back to `undefined` (rather
 * than trusting an unrecognized string) for a run whose `pipeline` field
 * predates the current pipeline vocabulary. */
function latestOrchestratorPipeline(
  runs: { pipeline: string; createdAt: string }[],
): Pipeline | undefined {
  const latest = runs
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .at(0);
  return latest && isDispatchPipeline(latest.pipeline)
    ? latest.pipeline
    : undefined;
}

/**
 * Re-requests work on a task through the orchestrator (#1183): unlike the
 * legacy broker's label-driven admission, the orchestrator's `request()` is
 * the one dispatch entry point, keyed by the task's own `TaskId` (issue
 * number in the control-plane repository - orchestrator tracks no other
 * repository, see `deployment.ts`'s `controlPlaneRepository`). A Retry click
 * always mints a fresh idempotency key: unlike a webhook replay, there is no
 * meaningful "same request" to converge on.
 */
export async function retriggerIssue(
  repo: WatchedRepo,
  issueNumber: number,
  callerId: string,
  note?: string,
  actorLogin?: string,
): Promise<RetriggerOutcome> {
  if (!DISPATCH_CALLER_ID_PATTERN.test(callerId)) {
    throw new ActionError('A valid dispatch caller ID is required', 400);
  }

  const runtime = createOrchestratorRuntime();
  const { store, orchestrator, drain } = runtime;
  const taskId = { repo: controlPlaneRepository(), issue: issueNumber };
  const [runs, existingTask] = await Promise.all([
    store.listRuns(taskId),
    store.readTask(taskId),
  ]);
  const previousPipeline = latestOrchestratorPipeline(runs);
  const pipelineFallback = previousPipeline === undefined;
  const pipeline = previousPipeline ?? RETRIGGER_FALLBACK_PIPELINE;
  const integration = requireAgentIntegration(repo, pipeline);

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
    if (containsReplyTrigger(trimmedNote, integration)) {
      return { pipelineFallback };
    }
  }

  // A task that already carries `work` keeps it forever (decide.ts's
  // "write once" rule) -- deriving one here would be discarded, so this
  // reads the live issue only when there is something for the derivation
  // to actually set.
  let work;
  if (existingTask?.task.work === undefined) {
    const octokit = getGithubClient();
    const { data: issue } = await octokit.rest.issues.get({
      owner: repo.owner,
      repo: repo.name,
      issue_number: issueNumber,
    });
    work = workPayloadFromGithub({
      title: issue.title,
      body: issue.body,
      pipeline,
      repo: repoKey(repo),
      actor: actorLogin,
    });
  }

  const outcome = await orchestrator.request({
    taskId,
    requestId: `console-retry:${randomUUID()}`,
    pipeline,
    params: { mode: 'implement' },
    ...(work === undefined ? {} : { work }),
  });
  if (isRefusal(outcome)) {
    if (outcome.reason === 'task-busy') {
      throw new ActionError('A run is already active for this task', 409);
    }
    // `request()` only ever refuses with `task-busy` or `duplicate-request`
    // (see decide.ts's `requestRun`), and the freshly minted requestId above
    // can never collide with an existing run - any other outcome means the
    // decision layer's contract changed underneath us.
    throw new ActionError('Retrigger could not be processed', 500);
  }
  await drain();
  return { pipelineFallback };
}

// The console's "hand this off to a different agent" action (#143) - e.g. a
// codex run got stuck and the maintainer wants claude to pick it up instead.
// Distinct from retriggerIssue's same-pipeline cycle: this swaps which
// pipeline label the issue carries rather than re-firing the one it already
// has.
//
// #1183: this used to delegate the whole transition to the hosted
// controller's `reassign-pipeline` command (a `DispatchLedger`-era concept -
// see #811's history in git blame). The orchestrator has no notion of "a
// pipeline label" at all (#1183's model is a per-task mutex over runs, not a
// GitHub-label-driven admission loop), so this now does the two things a
// reassignment actually means under that model directly: swap the issue's
// own `agent:*` label (still the fleet's own routing/display truth - the
// dashboard, RetriggerButton, and webhook-driven mention dispatch all read
// it), then hand the task's lock to the new pipeline through the
// orchestrator - canceling whatever run currently holds it before
// requesting a fresh one. `callerId` remains the console's own stable
// per-click UUID (see retrigger-button.tsx's `createRandomId()` sibling in
// item-overflow-menu.tsx) for the malformed-input guard below; the
// orchestrator idempotency key is minted fresh, same as retriggerIssue.
export async function reassignPipeline(
  repo: WatchedRepo,
  issueNumber: number,
  targetPipeline: Pipeline,
  callerId: string,
  actorLogin?: string,
): Promise<void> {
  if (!DISPATCH_CALLER_ID_PATTERN.test(callerId)) {
    throw new ActionError('A valid dispatch caller ID is required', 400);
  }
  // Repo-config gate: does this specific watched repo even declare an
  // integration for the target pipeline at all.
  const targetIntegration = requireAgentIntegration(repo, targetPipeline);
  // This repo's own configured labels (not the fleet-wide default): a
  // watched repo's `agents` config can override the `agent:*` label per
  // pipeline (#811 Codex review on #904).
  const pipelineLabels = supportedAgentPipelines(repo)
    .map((pipeline) => agentIntegration(repo, pipeline)?.label)
    .filter((label): label is string => Boolean(label));

  const octokit = getGithubClient();
  const { data: issue } = await octokit.rest.issues.get({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
  });
  const labels = issue.labels.map((label) =>
    typeof label === 'string' ? label : (label.name ?? ''),
  );
  // Same reasoning as retriggerIssue's own clearNeedsHumanLabel call: a
  // reassignment hands the task to a fresh agent, so any pending
  // needs-human park state clears in the same atomic write rather than
  // lingering under a pipeline label that no longer matches who owns it.
  await octokit.rest.issues.setLabels({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    labels: labels
      .filter(
        (label) =>
          !pipelineLabels.includes(label) && label !== 'status:needs-human',
      )
      .concat(targetIntegration.label),
  });

  const runtime = createOrchestratorRuntime();
  const { store, orchestrator, drain } = runtime;
  const taskId = { repo: controlPlaneRepository(), issue: issueNumber };
  const [activeRun, existingTask] = await Promise.all([
    store.readActiveRun(taskId),
    store.readTask(taskId),
  ]);
  if (activeRun) {
    // `cancel` only ever refuses `unknown-run`/`run-not-live` - both mean
    // the run already stopped being live between the read above and this
    // call, which is exactly the outcome cancellation wants anyway.
    await orchestrator.cancel(
      activeRun.runId,
      `reassigned to ${targetPipeline} from console`,
    );
  }

  // Reuses the issue already read above for the label swap -- no second
  // GitHub call, unlike retriggerIssue, which has no other reason to read
  // the issue. Same write-once reasoning as retriggerIssue's own `work`
  // derivation (decide.ts's "write once" rule).
  const work =
    existingTask?.task.work === undefined
      ? workPayloadFromGithub({
          title: issue.title,
          body: issue.body,
          pipeline: targetPipeline,
          repo: repoKey(repo),
          actor: actorLogin,
        })
      : undefined;

  const outcome = await orchestrator.request({
    taskId,
    requestId: `console-reassign:${randomUUID()}`,
    pipeline: targetPipeline,
    params:
      activeRun?.params?.mode !== undefined
        ? { mode: activeRun.params.mode }
        : { mode: 'implement' },
    ...(work === undefined ? {} : { work }),
  });
  if (isRefusal(outcome)) {
    if (outcome.reason === 'task-busy') {
      throw new ActionError('A run is already active for this task', 409);
    }
    // Same unreachable-in-practice guard as retriggerIssue's own request().
    throw new ActionError('Reassignment could not be processed', 500);
  }
  await drain();
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

type AppIssueCreate = ReturnType<
  typeof getGithubClient
>['rest']['issues']['create'];
export type QuickTaskIssueCreator = (
  parameters: NonNullable<Parameters<AppIssueCreate>[0]>,
) => ReturnType<AppIssueCreate>;

/**
 * Server-only input for the future multipart route. It is intentionally not
 * part of QuickTaskRequest: the existing action and broker wire contract stay
 * byte-for-byte compatible for Quick Tasks without evidence.
 */
export interface QuickTaskEvidenceLifecycle {
  intent: QuickTaskEvidenceIntent;
  hook: QuickTaskEvidencePreIssueCreateHook;
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
    const { data: issue } = await (
      issueCreator ?? ((parameters) => octokit.rest.issues.create(parameters))
    )({
      owner: request.repository.owner,
      repo: request.repository.name,
      title: request.title,
      body: `${request.description}\n\n${formatQuickTaskMarker({ requestId: request.requestId, digest })}`,
      labels: [QUICK_TASK_LABEL, integration.label],
    });
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
  {
    digest: string;
    evidenceLifecycle?: QuickTaskEvidenceLifecycle;
    promise: Promise<QuickTaskReceipt>;
  }
>();

export function createQuickTask(
  rawRequest: QuickTaskRequest & { repository: WatchedRepo },
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
    // Evidence bytes are intentionally not in the broker-visible issue
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
