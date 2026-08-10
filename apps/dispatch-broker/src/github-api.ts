import type {
  DispatchPipeline,
  LedgerGeneration,
  LedgerRunAttempt,
  LedgerTaskRef,
} from '@agent-lcars/dispatch-contracts';
import type { DispatchLedger } from '@agent-lcars/dispatch-contracts';
import {
  DISPATCH_PIPELINES,
  displayTitleMatchesAttempt,
  workerWorkflow,
} from '@agent-lcars/dispatch-contracts';

import {
  createLedger,
  LEDGER_MARKER,
  parseLedgerComment,
  renderLedgerComment,
} from './broker';

const API_VERSION = '2026-03-10';

class GitHubApiError extends Error {
  status: number | undefined;
  data: unknown;

  constructor(message: string, status?: number, data?: unknown) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.data = data;
  }
}

class LedgerProjectionRepairError extends Error {
  constructor(
    public readonly commentId: number,
    public readonly status: number,
  ) {
    super(
      `Failed to remove extra dispatch-ledger marker comment ${commentId}: HTTP ${status}`,
    );
    this.name = 'LedgerProjectionRepairError';
  }
}

// --- GitHub REST shapes this file reads/writes. One set covering every
// endpoint this file calls -- issue/comment/timeline/run listings and the
// dispatch/response envelopes -- each function below reads only the fields
// it actually needs, exactly as the untyped original did. ---

/** The minimal shape `request()` below actually reads off a fetch response
 *  -- narrower than the real DOM/undici `Response` so a test's minimal mock
 *  (`{ status, headers, text }`) is exactly what this function depends on,
 *  not everything `fetch` happens to also return. The real global `fetch`
 *  satisfies this structurally, since `Response` is a strict superset. */
interface FetchLikeResponse {
  status: number;
  headers: Headers;
  text: () => Promise<string>;
}

type FetchImpl = (url: string, init: RequestInit) => Promise<FetchLikeResponse>;

interface RequestOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
}

interface RawResponse {
  status: number;
  data: unknown;
  headers: Headers;
}

/** `createGitHubApi()`'s return shape. `requestOk` is generic because its
 *  return shape is entirely endpoint-dependent; each call site names the
 *  shape it expects, exactly as main.mjs's own copy of this interface
 *  does. */
interface GitHubApi {
  request: (path: string, options?: RequestOptions) => Promise<RawResponse>;
  requestOk: <T = unknown>(
    path: string,
    options?: RequestOptions,
  ) => Promise<T>;
}

interface CreateGitHubApiOptions {
  token: string;
  fetchImpl?: FetchImpl;
  baseUrl?: string;
}

/** The narrowest TaskRef slice `repositoryPath` and
 *  `validateDispatchResponse` need. */
type RepositoryRef = Pick<LedgerTaskRef, 'repository'>;

interface GitHubUserRef {
  login?: string;
  type?: string;
}

interface GitHubLabelRef {
  name: string;
}

interface GitHubIssueComment {
  id: number;
  body: string;
  created_at: string;
  author_association?: string;
  user?: GitHubUserRef;
  pin?: boolean;
}

interface GitHubIssueDetail {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  user?: GitHubUserRef;
  labels?: (string | GitHubLabelRef)[];
  assignees?: GitHubUserRef[];
  pull_request?: unknown;
  created_at: string;
  updated_at: string;
  merged?: boolean;
  merged_at?: string | null;
}

interface GitHubReadinessIssue {
  number: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  state?: string;
  pull_request?: unknown;
}

export interface LaneReadinessBlocker {
  issue: number;
  title: string;
  url: string;
  source: 'lane-incident';
}

/** A GitHub Actions workflow run, as returned by both the single-run GET
 *  and the runs-list endpoints this file reads. */
interface WorkflowRun {
  id: number;
  url: string;
  html_url: string;
  status: string;
  conclusion: string | null;
  updated_at: string;
  display_title?: string;
  repository?: { id: number };
  event?: string;
  path?: string;
}

interface WorkflowRunsListResponse {
  workflow_runs?: WorkflowRun[];
}

/** `loadLedger()`/`saveLedger()`'s return shape -- the ledger paired with
 *  the GitHub comment carrying it. */
interface LoadedLedger {
  ledger: DispatchLedger;
  comment: GitHubIssueComment;
  created: boolean;
  existingComments?: GitHubIssueComment[];
}

function createGitHubApi({
  token,
  fetchImpl = fetch,
  baseUrl = 'https://api.github.com',
}: CreateGitHubApiOptions): GitHubApi {
  async function request(
    path: string,
    { method = 'GET', body, timeoutMs = 30_000 }: RequestOptions = {},
  ): Promise<RawResponse> {
    let response: FetchLikeResponse;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': API_VERSION,
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new GitHubApiError(
        // Genuinely untrusted here -- whatever fetchImpl rejected with, of
        // any shape. Every real fetch failure is Error-shaped; same
        // assumption the untyped original made without checking.
        `GitHub request transport failure: ${(error as Error).message}`,
        undefined,
      );
    }
    const text = await response.text();
    let data: unknown;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { malformedBody: text.slice(0, 500) };
      }
    }
    return { status: response.status, data, headers: response.headers };
  }

  async function requestOk<T = unknown>(
    path: string,
    options?: RequestOptions,
  ): Promise<T> {
    const response = await request(path, options);
    if (response.status < 200 || response.status >= 300) {
      throw new GitHubApiError(
        `GitHub request failed with HTTP ${response.status}`,
        response.status,
        response.data,
      );
    }
    // Every caller names the shape it expects via T; GitHub's actual
    // response body is never validated against it here, same trust
    // boundary the untyped original had (the caller is on the hook for
    // reading only fields it can tolerate being wrong).
    return response.data as T;
  }

  return { request, requestOk };
}

function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo, extra] = repository.split('/');
  if (!owner || !repo || extra) throw new Error('Invalid repository identity');
  return { owner, repo };
}

function repositoryPath(task: RepositoryRef): string {
  const { owner, repo } = splitRepository(task.repository);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

async function listAll<T>(api: GitHubApi, path: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const data = await api.requestOk(
      `${path}${separator}per_page=100&page=${page}`,
    );
    if (!Array.isArray(data))
      throw new Error('GitHub pagination response is not an array');
    all.push(...data);
    if (data.length < 100) return all;
  }
  throw new Error('GitHub pagination exceeded safety bound');
}

const laneReadinessMarker = (pipeline: string): string =>
  `<!-- agent-lcars:lane-readiness:v1:${pipeline} -->`;

/**
 * Read the runner platform's durable readiness projections. Open lane
 * incident issues are external health input to the controller, not state
 * the controller owns. A lane-specific incident is added after a worker
 * proves a shared credential/provider prerequisite failed. Listing issues rather
 * than using Search is intentional: issue-list reads are immediately
 * consistent enough to stop the next serialized dispatch, while search
 * indexing can lag behind the incident creation that must trip this breaker.
 */
async function readLaneReadiness(
  api: GitHubApi,
  task: LedgerTaskRef,
  pipeline: DispatchPipeline,
): Promise<LaneReadinessBlocker[]> {
  const expected = new Map<string, LaneReadinessBlocker['source']>([
    [laneReadinessMarker(pipeline), 'lane-incident'],
  ]);
  const root = repositoryPath(task);
  const issues = await listAll<GitHubReadinessIssue>(
    api,
    `${root}/issues?state=open`,
  );
  const blockers: LaneReadinessBlocker[] = [];
  for (const issue of issues) {
    if (issue.pull_request || typeof issue.body !== 'string') continue;
    for (const [marker, source] of expected) {
      if (!issue.body.includes(marker)) continue;
      blockers.push({
        issue: issue.number,
        title: issue.title ?? `Readiness incident #${issue.number}`,
        url:
          issue.html_url ??
          `https://github.com/${task.repository}/issues/${issue.number}`,
        source,
      });
      break;
    }
  }
  return blockers.sort((left, right) => left.issue - right.issue);
}

/**
 * Open one durable incident per lane after a trusted completion callback
 * identifies a shared startup prerequisite. Codex incidents remain
 * human-closed because that subscription credential has no honest network
 * probe.
 */
async function ensureLaneReadinessAlert(
  api: GitHubApi,
  task: LedgerTaskRef,
  pipeline: DispatchPipeline,
  failure: 'credential' | 'provider' | 'bootstrap',
  runUrl: string,
  maintainer: string,
  evidenceSource: 'worker-completion' | 'probe' = 'worker-completion',
): Promise<GitHubReadinessIssue> {
  const marker = laneReadinessMarker(pipeline);
  const root = repositoryPath(task);
  const open = (
    await listAll<GitHubReadinessIssue>(api, `${root}/issues?state=open`)
  )
    .filter(
      (issue) =>
        !issue.pull_request &&
        typeof issue.body === 'string' &&
        issue.body.includes(marker),
    )
    .sort((left, right) => left.number - right.number);
  if (open.length > 0) return open[0];

  const display = pipeline[0].toUpperCase() + pipeline.slice(1);
  const resumeTrigger =
    pipeline === 'claude'
      ? 'repair or rotate the credential. The isolated trusted Claude probe will close this incident only after a verified successful harness turn; scheduled reconcile will then resume held work automatically.'
      : 'repair or rotate the affected prerequisite, verify the lane is healthy, then close this issue. Scheduled reconcile will resume held accepted work automatically.';
  const observation =
    evidenceSource === 'probe'
      ? 'An isolated trusted harness probe reported'
      : 'A trusted worker completion reported';
  return api.requestOk<GitHubReadinessIssue>(`${root}/issues`, {
    method: 'POST',
    body: {
      title: `${display} agent lane is unavailable`,
      body: `${marker}\n\n${observation} a shared **${failure}** readiness failure for the \`${pipeline}\` lane.\n\n- First observed run: ${runUrl}\n- Effect: the broker will not allocate another ${display} worker while this issue is open.\n- Resume trigger: ${resumeTrigger}`,
      labels: ['status:needs-human'],
      ...(maintainer ? { assignees: [maintainer] } : {}),
    },
  });
}

/**
 * Resolve every open incident for one lane after a distinct trusted probe has
 * positively verified recovery. Closing all matches is deliberate: the read
 * side treats any matching open marker as a blocker, so leaving a duplicate
 * behind would keep accepted work parked even though the credential is known
 * healthy. The exact probe run is appended in the same issue PATCH that
 * closes the incident, making recovery evidence durable and idempotent.
 */
async function resolveLaneReadinessAlerts(
  api: GitHubApi,
  task: LedgerTaskRef,
  pipeline: DispatchPipeline,
  probeRunUrl: string,
): Promise<GitHubReadinessIssue[]> {
  const marker = laneReadinessMarker(pipeline);
  const root = repositoryPath(task);
  const open = (
    await listAll<GitHubReadinessIssue>(api, `${root}/issues?state=open`)
  )
    .filter(
      (issue) =>
        !issue.pull_request &&
        typeof issue.body === 'string' &&
        issue.body.includes(marker),
    )
    .sort((left, right) => left.number - right.number);

  for (const issue of open) {
    const recoveryEvidence = `- Verified recovery probe: ${probeRunUrl}`;
    const body = issue.body?.includes(recoveryEvidence)
      ? issue.body
      : `${issue.body?.trim() ?? marker}\n\n${recoveryEvidence}`;
    await mutateOrVerify(
      () =>
        api.requestOk(`${root}/issues/${issue.number}`, {
          method: 'PATCH',
          body: { body, state: 'closed', state_reason: 'completed' },
        }),
      async () => {
        const current = await api.requestOk<GitHubReadinessIssue>(
          `${root}/issues/${issue.number}`,
        );
        return (
          current.state === 'closed' &&
          typeof current.body === 'string' &&
          current.body.includes(recoveryEvidence)
        );
      },
    );
  }
  return open;
}

// Bounded fan-out for action adapters that make independent GitHub writes.
// This keeps each item's success/failure independent while avoiding a burst
// large enough to trigger GitHub secondary rate limits, mirroring
// Promise.allSettled's per-item `{status, value}` / `{status, reason}`
// result shape (in the same order as `items`) so callers built around that
// shape don't need to change.
interface ConcurrencyFulfilled<R> {
  status: 'fulfilled';
  value: R;
}

interface ConcurrencyRejected {
  status: 'rejected';
  reason: unknown;
}

type ConcurrencyOutcome<R> = ConcurrencyFulfilled<R> | ConcurrencyRejected;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<ConcurrencyOutcome<R>[]> {
  const results: ConcurrencyOutcome<R>[] = new Array(items.length);
  let cursor = 0;
  async function runNext(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = {
          status: 'fulfilled',
          value: await worker(items[index], index),
        };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    workers.push(runNext());
  }
  await Promise.all(workers);
  return results;
}

interface LoadLedgerOptions {
  createIfMissing?: boolean;
}

export interface LedgerProjectionIdentity {
  login: string;
  type: 'Bot' | 'User';
}

async function loadLedger(
  api: GitHubApi,
  task: LedgerTaskRef,
  workflowIdentity = 'github-actions[bot]',
  { createIfMissing = true }: LoadLedgerOptions = {},
): Promise<LoadedLedger | undefined> {
  const root = repositoryPath(task);
  const comments = await listAll<GitHubIssueComment>(
    api,
    `${root}/issues/${task.issue}/comments`,
  );
  const candidates = comments.filter((comment) =>
    comment.body?.includes(LEDGER_MARKER),
  );
  if (candidates.length > 1) {
    throw new Error('Duplicate dispatch ledger comments');
  }
  if (candidates.length === 1) {
    const comment = candidates[0];
    if (
      comment.user?.login !== workflowIdentity ||
      comment.user?.type !== 'Bot'
    ) {
      throw new Error('Dispatch ledger author is not the workflow identity');
    }
    return {
      comment,
      ledger: parseLedgerComment(comment.body, task),
      created: false,
    };
  }

  if (!createIfMissing) return undefined;

  const ledger = createLedger(task);
  const comment = await api.requestOk<GitHubIssueComment>(
    `${root}/issues/${task.issue}/comments`,
    {
      method: 'POST',
      body: { body: renderLedgerComment(ledger) },
    },
  );
  if (!Number.isSafeInteger(comment?.id)) {
    throw new Error('GitHub did not return the created ledger comment ID');
  }
  return { comment, ledger, created: true, existingComments: comments };
}

/**
 * Locate or create the human-facing ledger comment without parsing it as
 * controller state. The controller calls this only after Firestore has been
 * read and leased, so a controlled worker can neither corrupt nor duplicate
 * comments to block the controller from reaching its real state.
 */
async function loadLedgerProjection(
  api: GitHubApi,
  task: LedgerTaskRef,
  ledger: DispatchLedger,
  controllerIdentities: readonly LedgerProjectionIdentity[] = [
    { login: 'github-actions[bot]', type: 'Bot' },
  ],
): Promise<LoadedLedger> {
  const root = repositoryPath(task);
  const comments = await listAll<GitHubIssueComment>(
    api,
    `${root}/issues/${task.issue}/comments`,
  );
  const markerCandidates = comments.filter((comment) =>
    comment.body?.includes(LEDGER_MARKER),
  );
  const ownedCandidates = markerCandidates
    .filter(
      (comment) =>
        comment.body?.includes(LEDGER_MARKER) &&
        controllerIdentities.some(
          (identity) =>
            comment.user?.login === identity.login &&
            comment.user?.type === identity.type,
        ),
    )
    .sort((left, right) => left.id - right.id);
  let comment = ownedCandidates[0];
  let created = false;
  if (!comment) {
    comment = await api.requestOk<GitHubIssueComment>(
      `${root}/issues/${task.issue}/comments`,
      {
        method: 'POST',
        body: { body: renderLedgerComment(ledger) },
      },
    );
    if (!Number.isSafeInteger(comment?.id)) {
      throw new Error('GitHub did not return the created ledger comment ID');
    }
    created = true;
  }

  // Worker preflight remains a strict compatibility reader until that
  // capability moves into the hosted controller. Repair every extra marker
  // while this authority holder owns the task lease, regardless of author:
  // controlled workers comment through the App bot rather than the workflow
  // bot, and strict preflight rejects duplicate markers before author checks.
  for (const duplicate of markerCandidates.filter(
    (candidate) => candidate.id !== comment.id,
  )) {
    const response = await api.request(
      `${root}/issues/comments/${duplicate.id}`,
      { method: 'DELETE' },
    );
    if (
      response.status !== 404 &&
      (response.status < 200 || response.status >= 300)
    ) {
      throw new LedgerProjectionRepairError(duplicate.id, response.status);
    }
    console.log(
      `::notice::Removed extra dispatch-ledger marker comment ${duplicate.id}.`,
    );
  }
  return {
    comment,
    ledger,
    created,
    ...(created && { existingComments: comments }),
  };
}

export type AuthorityInitializationEvidence =
  'compatibility-projection' | 'pre-cutover' | 'post-cutover';

/**
 * Classify the evidence available when an authority record is missing.
 *
 * Marker absence is not evidence: a controlled worker can edit or delete
 * comments. The trusted cutover epoch and GitHub's immutable issue/PR
 * `created_at` are the non-forgeable boundary. Tasks created before that
 * boundary must already have an aggregate, so missing state fails
 * closed even if every compatibility marker has been removed. Tasks created
 * at or after the boundary are genuinely post-authority and may be seeded.
 */
async function classifyAuthorityTaskInitialization(
  api: GitHubApi,
  task: LedgerTaskRef,
  authorityEpoch: string,
  controllerIdentities: readonly LedgerProjectionIdentity[] = [
    { login: 'github-actions[bot]', type: 'Bot' },
  ],
): Promise<AuthorityInitializationEvidence> {
  const comments = await listAll<GitHubIssueComment>(
    api,
    `${repositoryPath(task)}/issues/${task.issue}/comments`,
  );
  // Projection presence is tracking evidence only when the canonical
  // controller identity authored it. Other App/bot credentials are
  // available to controlled worker jobs and cannot prove authority history.
  const hasProjection = comments.some(
    (comment) =>
      comment.body?.includes(LEDGER_MARKER) &&
      controllerIdentities.some(
        (identity) =>
          comment.user?.login === identity.login &&
          comment.user?.type === identity.type,
      ),
  );
  if (hasProjection) return 'compatibility-projection';

  const epoch = Date.parse(authorityEpoch);
  if (!Number.isFinite(epoch)) {
    throw new Error(
      `DISPATCH_AUTHORITY_EPOCH must be a valid timestamp, got ${JSON.stringify(authorityEpoch)}`,
    );
  }
  const issue = await api.requestOk<GitHubIssueDetail>(
    `${repositoryPath(task)}/issues/${task.issue}`,
  );
  const createdAt = Date.parse(issue.created_at);
  if (!Number.isFinite(createdAt)) {
    throw new Error(
      `GitHub returned an invalid created_at for ${task.repository}#${task.issue}`,
    );
  }
  return createdAt >= epoch ? 'post-cutover' : 'pre-cutover';
}

async function saveLedger(
  api: GitHubApi,
  loaded: LoadedLedger,
): Promise<LoadedLedger> {
  const root = repositoryPath(loaded.ledger.task);
  const comment = await api.requestOk<GitHubIssueComment>(
    `${root}/issues/comments/${loaded.comment.id}`,
    {
      method: 'PATCH',
      body: { body: renderLedgerComment(loaded.ledger) },
    },
  );
  loaded.comment = comment;
  return loaded;
}

interface PinResult {
  pinned: boolean;
  reason?: string;
}

async function pinLedgerWhenUnoccupied(
  api: GitHubApi,
  loaded: LoadedLedger,
  isPullRequest: boolean,
): Promise<PinResult> {
  if (!loaded.created || isPullRequest)
    return { pinned: false, reason: 'ineligible' };
  // `existingComments` is only ever unset when `created` is false -- see
  // loadLedger's own construction, which always pairs the two -- and the
  // guard above already proved `created` is true.
  const { existingComments } = loaded;
  if (!existingComments) {
    throw new Error(
      'LoadedLedger.existingComments missing despite created=true',
    );
  }
  if (existingComments.some((comment) => comment.pin)) {
    return { pinned: false, reason: 'occupied' };
  }
  const root = repositoryPath(loaded.ledger.task);
  try {
    await api.requestOk(`${root}/issues/comments/${loaded.comment.id}/pin`, {
      method: 'PUT',
    });
    return { pinned: true };
  } catch (error) {
    return {
      pinned: false,
      // Every requestOk failure throws a GitHubApiError (see request()
      // above); this mirrors the untyped original's own optional-chained
      // `error.status` read for anything else.
      reason: `best-effort-failed:${error instanceof GitHubApiError ? (error.status ?? 'transport') : 'transport'}`,
    };
  }
}

// workerConfigurations/agentWorkerPipelines/workerWorkflow used to be
// github-api.mjs's own hand-copied worker registry. They now come straight
// from the shared libs/dispatch-contracts/src/pipelines.js definitions
// (DISPATCH_PIPELINES/workerWorkflow, imported above), re-exported under their
// original names so existing importers (main.mjs, workflow-contract.test.mjs,
// github-api.test.mjs) don't churn.
const agentWorkerPipelines = DISPATCH_PIPELINES;

/** What GitHub's own workflow-dispatch response body must decode to;
 *  validated field by field below before any field is trusted. */
interface DispatchResponseData {
  workflow_run_id?: unknown;
  run_url?: unknown;
  html_url?: unknown;
}

function validateDispatchResponse(
  response: { status: number; data: unknown },
  task: RepositoryRef,
): { runId: number; runUrl: string; htmlUrl: string } {
  if (response.status !== 200) {
    throw new GitHubApiError(
      `Workflow dispatch returned HTTP ${response.status}`,
      response.status,
      response.data,
    );
  }
  // Genuinely untrusted -- GitHub's POST .../dispatches response body,
  // checked field by field below before any field is trusted.
  const data = response.data as DispatchResponseData | null | undefined;
  const runId = data?.workflow_run_id;
  const runUrl = data?.run_url;
  const htmlUrl = data?.html_url;
  const { owner, repo } = splitRepository(task.repository);
  const expectedRunUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`;
  const expectedHtmlUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
  if (
    !Number.isSafeInteger(runId) ||
    // isSafeInteger's signature accepts `unknown` but does not narrow it --
    // same posture as ledger-core.ts's assertTaskRef, which casts for the
    // same reason immediately after an identical guard.
    (runId as number) <= 0 ||
    typeof runUrl !== 'string' ||
    runUrl !== expectedRunUrl ||
    typeof htmlUrl !== 'string' ||
    htmlUrl !== expectedHtmlUrl
  ) {
    throw new GitHubApiError(
      'Workflow dispatch returned malformed run details',
      200,
      response.data,
    );
  }
  return { runId: runId as number, runUrl, htmlUrl };
}

/** `beginDispatch` (modules/scheduler.mjs) always sets `attempt` together
 *  with the `dispatching` state a generation is in by the time
 *  dispatchAccepted (main.mjs) calls this -- this makes that invariant
 *  explicit rather than dereferencing undefined and blaming the caller. */
function attemptOf(generation: LedgerGeneration): LedgerRunAttempt {
  const { attempt } = generation;
  if (!attempt) {
    throw new Error(`Generation ${generation.generation} has no attempt`);
  }
  return attempt;
}

async function dispatchWorker(
  api: GitHubApi,
  generation: LedgerGeneration,
  task: LedgerTaskRef,
): Promise<{
  runId: number;
  runUrl: string;
  htmlUrl: string;
  workflow: string;
}> {
  const workflow = workerWorkflow(generation.pipeline);
  const root = repositoryPath(task);
  const response = await api.request(
    `${root}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    {
      method: 'POST',
      body: {
        ref: 'main',
        inputs: {
          issue: String(task.issue),
          mode: generation.mode,
          reply: generation.reply ?? '',
          runbook: generation.runbook ?? '',
          context: generation.context ?? '',
          broker_intent_id: generation.intentId,
          broker_generation: String(generation.generation),
          // `beginDispatch` (modules/scheduler.mjs) always sets `attempt`
          // together with the `dispatching` state a generation is in by
          // the time dispatchAccepted (main.mjs) calls this -- same
          // assumption the untyped original made without checking.
          broker_dispatch_token: attemptOf(generation).token,
        },
      },
    },
  );
  return { ...validateDispatchResponse(response, task), workflow };
}

async function getWorkflowRun(
  api: GitHubApi,
  task: LedgerTaskRef,
  runId: number,
): Promise<WorkflowRun> {
  return api.requestOk<WorkflowRun>(
    `${repositoryPath(task)}/actions/runs/${runId}`,
  );
}

// Runs list responses are sorted newest-first, and a single `per_page=100`
// page only ever sees the 100 most recent runs of that workflow. A
// generation dispatched a while ago (exactly the scenario #305's reconciler
// exists to repair) can have accumulated 100+ more recent workflow_dispatch
// runs for the same pipeline since -- an unscoped, unpaginated call then
// falsely reports "no matching run" for a dispatch that genuinely still
// exists, and the reconciler's bounded-retry escalation (trackMissingRun)
// would eventually park a perfectly healthy dispatch (#363 review, P2).
//
// Two independent, compounding mitigations, both pure narrowing -- neither
// can ever cause a true match to be excluded:
//   1. Scope the query to `created` at or after this generation's own
//      dispatch time (with a small clock-skew buffer): a run for this
//      generation can never have been created earlier, so this only
//      shrinks the candidate set, and in the overwhelmingly common case
//      collapses it to a single page. Cheaper than deep pagination, so
//      applied first.
//   2. Still paginate a bounded number of pages within that scoped window
//      as defense in depth against pathological traffic even inside the
//      scoped range -- accumulating matches across every scanned page
//      (never stopping at the first match) so a genuine duplicate-attempt
//      run landing on a later page is still detected, not silently missed.
const FIND_RUNS_FOR_GENERATION_MAX_PAGES = 5;
const FIND_RUNS_FOR_GENERATION_CREATED_BUFFER_MS = 5 * 60 * 1000;

function createdAtOrAfterFilter(generation: LedgerGeneration): string {
  const dispatchedAt =
    generation.attempt?.dispatchStartedAt ?? generation.occurredAt;
  const parsed = Date.parse(dispatchedAt);
  if (Number.isNaN(parsed)) return '';
  const scoped = new Date(
    parsed - FIND_RUNS_FOR_GENERATION_CREATED_BUFFER_MS,
  ).toISOString();
  // GitHub's documented range-qualifier syntax for the `created` list
  // parameter (not the newer 2026-03-10-only surface used elsewhere in
  // this file): https://docs.github.com/search-github/searching-on-github/understanding-the-search-syntax
  return `&created=${encodeURIComponent(`>=${scoped}`)}`;
}

async function findRunsForGeneration(
  api: GitHubApi,
  task: LedgerTaskRef,
  generation: LedgerGeneration,
): Promise<WorkflowRun[]> {
  const workflow = workerWorkflow(generation.pipeline);
  const root = repositoryPath(task);
  const createdFilter = createdAtOrAfterFilter(generation);
  const matches: WorkflowRun[] = [];
  for (let page = 1; page <= FIND_RUNS_FOR_GENERATION_MAX_PAGES; page += 1) {
    const data = await api.requestOk<WorkflowRunsListResponse>(
      `${root}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch${createdFilter}&per_page=100&page=${page}`,
    );
    const runs = data.workflow_runs ?? [];
    for (const run of runs) {
      if (displayTitleMatchesAttempt(run.display_title, generation)) {
        matches.push(run);
      }
    }
    if (runs.length < 100) break;
  }
  return matches;
}

// Removes a stale `agent:*` label as part of the broker's dual-label
// self-heal (#304 audit item 4). A 404 means the label is already gone --
// either a prior, interrupted heal attempt already removed it, or a
// maintainer removed it manually in the same window -- and is treated as
// success rather than an error, since the desired end state (the label is
// gone) already holds. Any other non-2xx status is a real failure and
// propagates so the broker falls back to its normal fail-closed path.
async function removeIssueLabel(
  api: GitHubApi,
  task: LedgerTaskRef,
  label: string,
): Promise<{ removed: boolean }> {
  const root = repositoryPath(task);
  const response = await api.request(
    `${root}/issues/${task.issue}/labels/${encodeURIComponent(label)}`,
    { method: 'DELETE' },
  );
  if (response.status === 404) return { removed: false };
  if (response.status < 200 || response.status >= 300) {
    throw new GitHubApiError(
      `Failed to remove stale label ${label}: HTTP ${response.status}`,
      response.status,
      response.data,
    );
  }
  return { removed: true };
}

async function failClosed(
  api: GitHubApi,
  task: LedgerTaskRef,
  maintainer: string,
  error: unknown,
): Promise<never> {
  const originalError =
    error instanceof Error ? error : new Error(String(error));
  let fallbackError: Error | undefined;
  try {
    await ensureNeedsHumanParked(api, task, maintainer);
  } catch (parkingError) {
    fallbackError =
      parkingError instanceof Error
        ? parkingError
        : new Error(String(parkingError));
  }
  if (fallbackError) {
    // A fallback failure must not replace the broker failure that caused us
    // to park. AggregateError keeps both stacks/status codes visible in the
    // Actions log while `cause` identifies the primary failure explicitly.
    throw new AggregateError(
      [originalError, fallbackError],
      `Dispatch broker failed (${originalError.message}); ` +
        `fail-closed parking also failed (${fallbackError.message})`,
      { cause: originalError },
    );
  }
  throw originalError;
}

async function issueHasLabel(
  api: GitHubApi,
  task: LedgerTaskRef,
  label: string,
): Promise<boolean> {
  const issue = await api.requestOk<GitHubIssueDetail>(
    `${repositoryPath(task)}/issues/${task.issue}`,
  );
  return (issue.labels ?? []).some(
    (entry) => (typeof entry === 'string' ? entry : entry.name) === label,
  );
}

async function issueHasAssignee(
  api: GitHubApi,
  task: LedgerTaskRef,
  login: string,
): Promise<boolean> {
  const issue = await api.requestOk<GitHubIssueDetail>(
    `${repositoryPath(task)}/issues/${task.issue}`,
  );
  return (issue.assignees ?? []).some((assignee) => assignee.login === login);
}

// The reconciler's bounded-retry parking path (#305's repair table:
// "unrepairable -> status:needs-human + maintainer assignee"), reusing
// report-failure.sh's verify-then-decide convention in JS: `gh`/the REST
// API occasionally returns a non-2xx or a parse hiccup on a mutation that
// actually landed (agent-lcars#346). Unlike failClosed (used for genuinely
// unexpected errors, which always throws after parking so the triggering
// job fails loudly), reaching the bounded-retry limit is an ANTICIPATED
// terminal outcome, not a job failure -- callers of this function decide
// separately whether to throw; this function itself only throws when the
// mutation is genuinely, confirmably absent.
// Shared by the label and assignee mutations below: attempt the mutation,
// and only surface its error if `verify` confirms the mutation genuinely
// did not land (see the ensureNeedsHumanParked comment above for why a
// failure here can still mean success). The bash equivalent of this same
// pattern is report-failure.sh's `mutate_or_verify`.
async function mutateOrVerify(
  mutate: () => Promise<unknown>,
  verify: () => Promise<boolean>,
): Promise<void> {
  try {
    await mutate();
  } catch (error) {
    if (!(await verify())) throw error;
  }
}

async function ensureNeedsHumanParked(
  api: GitHubApi,
  task: LedgerTaskRef,
  maintainer: string,
): Promise<void> {
  const root = repositoryPath(task);
  await mutateOrVerify(
    () =>
      api.requestOk(`${root}/issues/${task.issue}/labels`, {
        method: 'POST',
        body: { labels: ['status:needs-human'] },
      }),
    () => issueHasLabel(api, task, 'status:needs-human'),
  );
  if (!maintainer) return;
  await mutateOrVerify(
    () =>
      api.requestOk(`${root}/issues/${task.issue}/assignees`, {
        method: 'POST',
        body: { assignees: [maintainer] },
      }),
    () => issueHasAssignee(api, task, maintainer),
  );
}

export {
  agentWorkerPipelines,
  API_VERSION,
  classifyAuthorityTaskInitialization,
  createGitHubApi,
  dispatchWorker,
  ensureLaneReadinessAlert,
  ensureNeedsHumanParked,
  failClosed,
  findRunsForGeneration,
  getWorkflowRun,
  GitHubApiError,
  LedgerProjectionRepairError,
  listAll,
  loadLedger,
  loadLedgerProjection,
  mapWithConcurrency,
  pinLedgerWhenUnoccupied,
  readLaneReadiness,
  removeIssueLabel,
  repositoryPath,
  resolveLaneReadinessAlerts,
  saveLedger,
  splitRepository,
  validateDispatchResponse,
  workerWorkflow,
};
