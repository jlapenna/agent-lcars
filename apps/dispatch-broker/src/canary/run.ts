// Production dispatch-broker canary lifecycle (#307, final child of epic
// #301). Reuses the shared authoritative task-state read contract used by
// the console rather than parsing the mutable GitHub compatibility comment:
// reuse one canonical, clearly-marked issue -> dispatch it
// through agent-router.yml's real `kind: 'canary'` broker path -> poll the
// Firestore-backed aggregate to a terminal state -> clean up (close on success,
// park status:needs-human with evidence on failure, mirroring
// github-api.ts's own failClosed/ensureNeedsHumanParked convention).
//
// Called by two workflows sharing this one action:
//   - dispatch-canary.yml: hourly + workflow_dispatch, no live-url probe.
//   - post-deploy-smoke.yml: chained off "Deploy console" completing,
//     supplies live-url so a broken deployed revision is caught before
//     (and instead of) exercising the broker.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  type DispatchLedger,
  formatAttemptId,
  HOSTED_TASK_STATE_URL,
  isAuthoritativeTaskState,
  type LedgerGeneration,
  type LedgerTaskRef,
} from '@agent-lcars/dispatch-contracts';

import {
  createGitHubApi,
  dispatchRouterEvent,
  ensureNeedsHumanParked,
  listAll,
  loadLedger,
  mapWithConcurrency,
  repositoryPath,
} from '../github-api';

// `createGitHubApi()`'s return shape -- see github-api.ts. Derived via
// ReturnType rather than a hand-copied local interface (main.ts's own
// GitHubApiClient) because GitHubApi itself isn't exported from that
// module; this stays exact without duplicating its shape.
type GitHubApiClient = ReturnType<typeof createGitHubApi>;
type CanaryGitHubApiClient = GitHubApiClient & {
  /** Test seam only; production reads the hosted endpoint with global fetch. */
  taskStateFetch?: typeof fetch;
};

// GitHub REST shapes this file reads. Minimal on purpose -- only the
// fields actually used below (see github-api.ts's own GitHubIssueDetail
// for the fuller shape other consumers need).
interface GitHubIssueSummary {
  number: number;
  title?: string;
  body?: string | null;
  created_at: string;
  updated_at?: string;
  labels?: (string | { name?: string })[];
  pull_request?: unknown;
}

type SleepImpl = (ms: number) => Promise<void>;
type FetchLike = (
  url: string,
  init: { method: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

// v1 marked one throwaway issue per run. The distinct v2 marker is the
// durable identity of the one canonical issue introduced by #677; it must
// not accidentally adopt one of the many historical v1 artifacts.
const CANARY_MARKER = '<!-- agent-lcars:dispatch-canary-canonical:v2 -->';
const LEGACY_CANARY_MARKER = '<!-- agent-lcars:dispatch-canary:v1 -->';
const CANARY_TITLE_PREFIX = '[dispatch-canary]';
const CANARY_TITLE = '[dispatch-canary] Production dispatch broker canary';
const LIVE_URL_PROBE_MAX_ATTEMPTS = 5;
const LIVE_URL_PROBE_RETRY_DELAY_MS = 15_000;
// #798 retires the self-hosted router and Action completion callback. The
// remaining canary-only router starts on GitHub-hosted infrastructure and the
// worker returns completion directly to the hosted controller, so the old
// 30-minute capacity-contention allowance would only delay a real alert.
// Ten minutes remains deliberately generous for GitHub scheduling, the
// worker/finalizer chain, projection convergence, and bounded API retries.
const LEDGER_POLL_TIMEOUT_MS = 10 * 60 * 1000;
// Mirrors ../main.ts's handleCompletion poll-until-terminal backoff (same
// start/cap/doubling shape) rather than a flat interval: start small so a
// fast-completing canary is detected quickly, double each attempt, and cap
// growth so a long wait doesn't hammer the API.
const LEDGER_POLL_BACKOFF_START_MS = 2_000;
const LEDGER_POLL_BACKOFF_MAX_MS = 15_000;
const TERMINAL_REJECTED_STATES = new Set([
  'dispatch-rejected',
  'superseded',
  'superseded-by-close',
]);
// A same-process try/catch (parkCanaryFailure in runDispatchCanary's own
// catch block) cannot survive the orchestrator's own job being killed --
// a job-level `timeout-minutes` or an operator/workflow cancellation tears
// down the whole runner process, including anything still awaiting inside
// pollCanaryLedger, before that catch block ever runs. Neither
// dispatch-canary.yml (timeout-minutes: 15) nor post-deploy-smoke.yml
// (timeout-minutes: 15) has a separate cleanup job to survive that -- this
// canary is a small, self-contained workflow, not embedded in
// deploy-console.yml's own job, so there is no natural place to split
// "verify" and "cleanup" into two jobs the way the epic design audit (#301)
// recommends for a job that also owns the production deploy itself.
//
// sweepStaleCanaries below is the deterministic-rediscovery backstop that
// design explicitly calls for instead: dispatch-canary.yml runs it, hourly,
// unconditionally, before refreshing the canonical canary, so a killed run's
// issue is found and closed/parked within one hour at the very most --
// still "automatically cleaned up" per #307's acceptance bar, just not
// synchronously. Pinned to exactly both orchestrators' own
// timeout-minutes: 15 job budget, not padded beyond it (PR #448 review):
// GitHub Actions kills a job the instant its own runtime hits
// timeout-minutes, so an open, marked canary issue older than that value
// can ONLY mean its own orchestrator run was killed before reaching its
// cleanup path -- there is no earlier moment at which that's already
// guaranteed true, and no later one is needed. Padding this further (as
// an earlier version of this comment reasoned "comfortably beyond" the
// job budget) only shrinks the window in which an orphan is stale enough
// to sweep but not yet old enough to pass this filter -- for an orphan
// that lands in that window right before an hourly pass, the janitor
// skips it and it waits a full extra cycle, silently breaking the "next
// pass" guarantee above. Keeping this well under the hourly cadence (15
// min < 60 min) still guarantees a genuinely killed run is swept by the
// very next scheduled pass.
const STALE_CANARY_AGE_MS = 15 * 60 * 1000;

function env(name: string, required = true): string {
  const value = process.env[name];
  if (required && !value) throw new Error(`${name} is required`);
  return value ?? '';
}

async function output(name: string, value: string): Promise<void> {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  await fs.appendFile(path, `${name}=${value}\n`, 'utf8');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ProbeLiveUrlOptions {
  fetchImpl?: FetchLike;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleepImpl?: SleepImpl;
}

type ProbeLiveUrlResult =
  { ok: true; status: number } | { ok: false; reason: string };

async function probeLiveUrl(
  url: string,
  {
    fetchImpl = fetch,
    maxAttempts = LIVE_URL_PROBE_MAX_ATTEMPTS,
    retryDelayMs = LIVE_URL_PROBE_RETRY_DELAY_MS,
    sleepImpl = sleep,
  }: ProbeLiveUrlOptions = {},
): Promise<ProbeLiveUrlResult> {
  let lastReason = 'never attempted';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return { ok: true, status: response.status };
      lastReason = `HTTP ${response.status}`;
    } catch (error) {
      lastReason = (error as Error).message;
    }
    if (attempt < maxAttempts) await sleepImpl(retryDelayMs);
  }
  return { ok: false, reason: lastReason };
}

interface IssueBodyContext {
  source: string;
  runUrl: string;
  deployRunUrl?: string;
}

function issueBody({ source, runUrl, deployRunUrl }: IssueBodyContext): string {
  const lines = [
    'Canonical automated production canary for the dispatch broker ' +
      '(#307, #677). Every run reuses this issue, dispatches it through ' +
      'the real broker and a dedicated no-op worker ' +
      '(`.github/workflows/agent-dispatch-canary.yml`), then closes it on ' +
      'success or leaves it open as a release blocker on failure. It never ' +
      'invokes a paid model, GCP credential, or self-hosted/privileged ' +
      'runner -- see docs/e2e-security-boundary.md.',
    '',
    `Source: ${source}`,
    `Orchestrator run: ${runUrl}`,
  ];
  if (deployRunUrl) lines.push(`Deploy run: ${deployRunUrl}`);
  lines.push('', CANARY_MARKER);
  return lines.join('\n');
}

async function prepareCanaryIssue(
  api: GitHubApiClient,
  repository: string,
  context: IssueBodyContext,
): Promise<{ number: number }> {
  const root = repositoryPath({ repository });
  const issues = await listAll<GitHubIssueSummary>(
    api,
    `${root}/issues?state=all`,
  );
  const canonical = issues.filter(
    (issue) =>
      !issue.pull_request &&
      issue.title?.startsWith(CANARY_TITLE_PREFIX) &&
      issue.body?.includes(CANARY_MARKER),
  );
  if (canonical.length > 1) {
    throw new Error(
      `Duplicate canonical dispatch canary issues: ${canonical
        .map((issue) => `#${issue.number}`)
        .join(', ')}`,
    );
  }

  const body = issueBody(context);
  if (canonical.length === 1) {
    const existing = canonical[0];
    await api.requestOk(`${root}/issues/${existing.number}`, {
      method: 'PATCH',
      // Reopening before the probe makes a killed orchestrator visible to
      // the stale-canary janitor. The broker deliberately allows only its
      // no-op canary pipeline to dispatch against the ledger's possibly
      // still-closed control projection; ordinary work remains fail-closed.
      body: { title: CANARY_TITLE, body, state: 'open' },
    });
    return { number: existing.number };
  }

  const issue = await api.requestOk<{ number?: unknown }>(`${root}/issues`, {
    method: 'POST',
    body: {
      title: CANARY_TITLE,
      body,
    },
  });
  if (!Number.isSafeInteger(issue?.number)) {
    throw new Error('GitHub did not return the canonical canary issue number');
  }
  // isSafeInteger narrows at runtime but not for TS -- same posture as
  // github-api.ts's findSupersedingRouterRun, which casts immediately
  // after an identical guard.
  return issue as { number: number };
}

async function dispatchRouterCanary(
  api: GitHubApiClient,
  repository: string,
  issueNumber: number,
  callerId: string,
): Promise<{ runId: number; runUrl: string; htmlUrl: string }> {
  return dispatchRouterEvent(
    api,
    { repository },
    {
      kind: 'canary',
      issue: String(issueNumber),
      caller_id: callerId,
    },
  );
}

// The canary issue is a public GitHub issue: any user (or a compromised
// third-party integration) can comment on it before the real broker ever
// writes its own ledger comment, including a fabricated-but-parseable
// comment containing LEDGER_MARKER and a completed/successful canary
// generation. Trusting "the first marker-bearing comment" the way an
// earlier version of this file did would let that forged comment make the
// orchestrator close the issue and report a false green even if the real
// broker never ran or genuinely failed.
//
// This is exactly the trust boundary ../github-api.ts's own loadLedger
// already defends for every other ledger read in this codebase: exactly
// one marker-bearing comment is ever trusted (more than one is treated as
// an anomaly and fails closed, never "pick the first"), and that one
// comment must be authored by the same workflow identity (REST-shaped
// `github-actions[bot]` login + `type: 'Bot'` -- see
// docs/bot-identity-formats.md) every ledger write in this repo already
// uses. Do not weaken or duplicate that rule here.
const LEDGER_WORKFLOW_IDENTITY = 'github-actions[bot]';

interface FoundGeneration {
  ledger: DispatchLedger;
  generation: LedgerGeneration;
  storageRevision?: number;
  authoritativeUpdatedAt?: string;
}

/**
 * The canary is the contract probe for three systems, not only a green
 * workflow conclusion. The controller must preserve the exact attempt
 * binding, the outcome finalizer must validate the attempt-scoped comment,
 * and the projector must publish a converged compatibility view. Keeping
 * these checks together prevents a controller-only success from masking a
 * broken finalizer or projector.
 */
function assertCanaryContracts({ ledger, generation }: FoundGeneration): void {
  const expectedAttemptId = formatAttemptId(generation);
  if (generation.attempt?.attemptId !== expectedAttemptId) {
    throw new Error(
      `Canary controller contract failed: expected attemptId '${expectedAttemptId}', ` +
        `got '${generation.attempt?.attemptId ?? 'missing'}'.`,
    );
  }
  if (generation.attempt.outcome !== 'comment') {
    throw new Error(
      `Canary finalizer contract failed: expected exact comment outcome, got ` +
        `'${generation.attempt.outcome ?? 'missing'}'.`,
    );
  }
  const projection = ledger.projection;
  if (
    projection?.state !== 'converged' ||
    projection.desiredRevision !== projection.observedRevision ||
    projection.desiredRevision !== ledger.revision - 1
  ) {
    throw new Error(
      `Canary projector contract failed: expected a converged checkpoint for the ` +
        `terminal ledger revision immediately before the checkpoint write, got ` +
        `${projection ? JSON.stringify(projection) : 'no projection status'}.`,
    );
  }
}

/**
 * A successful controller completion and its finalizer/projector writes are
 * separate ledger mutations. GitHub can therefore expose `completed/success`
 * before the exact outcome and the checkpoint for that new revision arrive.
 * Incomplete observations and checkpoints for an older ledger revision are
 * retryable; a value populated for the current target revision but wrong
 * remains a hard contract failure.
 */
function isCanaryContractObservationPending({
  ledger,
  generation,
}: FoundGeneration): boolean {
  const attempt = generation.attempt;
  if (attempt?.attemptId !== formatAttemptId(generation)) return false;
  if (attempt.outcome !== undefined && attempt.outcome !== 'comment') {
    return false;
  }

  const projection = ledger.projection;
  if (
    projection?.state === 'diverged' &&
    projection.desiredRevision === ledger.revision - 1
  ) {
    return false;
  }
  if (
    projection?.state === 'converged' &&
    projection.desiredRevision === ledger.revision - 1 &&
    projection.observedRevision !== projection.desiredRevision
  ) {
    return false;
  }

  if (attempt.outcome === undefined) return true;
  if (!projection || projection.state === 'pending') return true;
  return (
    (projection.state === 'converged' || projection.state === 'diverged') &&
    projection.desiredRevision !== ledger.revision - 1
  );
}

// Shared by the live poll below and sweepStaleCanaries' one-shot read. The
// endpoint exposes the controller aggregate from Firestore with the private
// attempt capability redacted. GitHub comments never participate in this
// decision; loadLedger is retained only by ledgerCommentDiagnostic below.
async function findCanaryGeneration(
  task: LedgerTaskRef,
  sourceId?: string,
  fetchImpl: typeof fetch = fetch,
  baseUrl = HOSTED_TASK_STATE_URL,
): Promise<FoundGeneration | undefined> {
  const [owner, repo] = task.repository.split('/');
  if (!owner || !repo) throw new Error(`Invalid repository ${task.repository}`);
  const url = new URL(
    `${baseUrl}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${task.issue}`,
  );
  url.searchParams.set('repositoryId', String(task.repositoryId));
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `Authoritative task-state read failed with HTTP ${response.status}`,
    );
  }
  const state: unknown = await response.json();
  if (!isAuthoritativeTaskState(state)) {
    throw new Error('Authoritative task-state response was malformed');
  }
  if (
    state.task.repositoryId !== task.repositoryId ||
    state.task.repository !== task.repository ||
    state.task.issue !== task.issue
  ) {
    throw new Error(
      'Authoritative task-state response did not match the requested task',
    );
  }
  const generation = state.controllerState.generations
    .filter(
      (candidate) =>
        candidate.pipeline === 'canary' &&
        (sourceId === undefined || candidate.sourceId === sourceId),
    )
    .sort((left, right) => right.generation - left.generation)[0];
  return generation
    ? {
        ledger: state.controllerState,
        generation,
        storageRevision: state.storageRevision,
        authoritativeUpdatedAt: state.updatedAt,
      }
    : undefined;
}

interface PollCanaryLedgerOptions {
  timeoutMs?: number;
  sleepImpl?: SleepImpl;
  now?: () => number;
  sourceId?: string;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
  taskStateUrl?: string;
}

function describeCanaryObservation(found?: FoundGeneration): string {
  if (!found) return 'awaiting a ledger generation for this caller';
  const { generation, ledger } = found;
  const attempt = generation.attempt;
  const projection = ledger.projection;
  return [
    `g${generation.generation}`,
    `state=${generation.state}`,
    `worker=${attempt?.htmlUrl ?? 'unbound'}`,
    `status=${attempt?.status ?? 'unknown'}`,
    `conclusion=${attempt?.conclusion ?? 'unknown'}`,
    `outcome=${attempt?.outcome ?? 'missing'}`,
    projection
      ? `projection=${projection.state}:${projection.observedRevision}/${projection.desiredRevision}@r${ledger.revision}`
      : 'projection=missing',
    `storage=r${found.storageRevision ?? 'unknown'}@${found.authoritativeUpdatedAt ?? 'unknown'}`,
  ].join(' ');
}

function elapsedSeconds(startedAt: number, observedAt: number): number {
  return Math.max(0, Math.round((observedAt - startedAt) / 1000));
}

async function pollCanaryLedger(
  api: CanaryGitHubApiClient,
  task: LedgerTaskRef,
  {
    timeoutMs = LEDGER_POLL_TIMEOUT_MS,
    sleepImpl = sleep,
    now = () => Date.now(),
    sourceId,
    log = console.log,
    fetchImpl,
    taskStateUrl,
  }: PollCanaryLedgerOptions = {},
): Promise<FoundGeneration & { rejected?: boolean }> {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let delay = LEDGER_POLL_BACKOFF_START_MS;
  let lastObservation: string | undefined;
  while (now() < deadline) {
    const found = await findCanaryGeneration(
      task,
      sourceId,
      fetchImpl ?? api.taskStateFetch,
      taskStateUrl,
    );
    const observation = describeCanaryObservation(found);
    if (observation !== lastObservation) {
      log(
        `::notice::canary ledger after ${elapsedSeconds(startedAt, now())}s: ${observation}`,
      );
      lastObservation = observation;
    }
    if (found?.generation.state === 'completed') {
      // A non-successful controller result is already terminal and should be
      // reported by runDispatchCanary immediately. For success, wait through
      // the real finalizer/projector visibility window observed in production
      // run 31267661432, but fail immediately when a populated contract is
      // wrong rather than laundering it into a timeout.
      if (found.generation.attempt?.conclusion !== 'success') return found;
      if (!isCanaryContractObservationPending(found)) {
        try {
          assertCanaryContracts(found);
        } catch (error) {
          throw new Error(
            `${(error as Error).message} Authoritative observation: ` +
              `${describeCanaryObservation(found)} source=${found.generation.sourceId}.`,
            { cause: error },
          );
        }
        return found;
      }
    }
    if (found && TERMINAL_REJECTED_STATES.has(found.generation.state)) {
      return { ...found, rejected: true };
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleepImpl(Math.min(delay, remaining));
    delay = Math.min(delay * 2, LEDGER_POLL_BACKOFF_MAX_MS);
  }
  throw new Error(
    'Timed out waiting for the canary dispatch ledger to reach a verified ' +
      `terminal contract after ${elapsedSeconds(startedAt, now())}s; last observation: ` +
      `${lastObservation ?? 'poll ended before the first observation'}`,
  );
}

interface CloseCanaryIssueContext {
  generation: LedgerGeneration;
  runUrl?: string;
  message?: string;
}

// `message` lets a caller (sweepStaleCanaries below) supply its own success
// comment instead of the default runUrl-templated one below, while still
// sharing the same comment-then-close sequence.
async function closeCanaryIssue(
  api: GitHubApiClient,
  task: LedgerTaskRef,
  { generation, runUrl, message }: CloseCanaryIssueContext,
): Promise<void> {
  const root = repositoryPath(task);
  const body =
    message ??
    `✅ Canary verified: dispatch broker generation g${generation.generation} ` +
      `completed successfully (worker run ${generation.attempt?.htmlUrl ?? 'n/a'}). ` +
      `Closing automatically. Orchestrator run: ${runUrl}`;
  await api.requestOk(`${root}/issues/${task.issue}/comments`, {
    method: 'POST',
    body: { body },
  });
  await api.requestOk(`${root}/issues/${task.issue}`, {
    method: 'PATCH',
    body: { state: 'closed', state_reason: 'completed' },
  });
  const unlabel = await api.request(
    `${root}/issues/${task.issue}/labels/${encodeURIComponent(
      'status:needs-human',
    )}`,
    { method: 'DELETE' },
  );
  if (unlabel.status !== 200 && unlabel.status !== 404) {
    throw new Error(
      `Could not clear status:needs-human from canonical canary issue: HTTP ${unlabel.status}`,
    );
  }
}

// Mirrors ../github-api.ts's failClosed/ensureNeedsHumanParked convention:
// a failure is never a silent log line. The issue stays OPEN with evidence
// (not auto-closed) so a maintainer has something concrete to act on --
// cleanup only ever closes a canary that actually verified successfully.
async function parkCanaryFailure(
  api: GitHubApiClient,
  task: LedgerTaskRef,
  maintainer: string,
  reason: string,
): Promise<void> {
  const root = repositoryPath(task);
  // A previous successful run leaves the canonical issue closed. Reopen it
  // before recording a failure so the one durable issue, rather than a new
  // artifact, becomes the visible release blocker.
  await api.requestOk(`${root}/issues/${task.issue}`, {
    method: 'PATCH',
    body: { state: 'open' },
  });
  try {
    await api.requestOk(`${root}/issues/${task.issue}/comments`, {
      method: 'POST',
      body: {
        body:
          `🚨 Canary failed: ${reason}\n\nThis issue is left open with ` +
          'evidence instead of being auto-closed. A maintainer must ' +
          'investigate.',
      },
    });
  } catch {
    // Best-effort: the label/assignee park below is the loud signal that
    // actually matters; a lost diagnostic comment must not mask it.
  }
  await ensureNeedsHumanParked(api, task, maintainer);
}

async function ledgerCommentDiagnostic(
  api: GitHubApiClient,
  task: LedgerTaskRef,
): Promise<string> {
  try {
    const loaded = await loadLedger(api, task, LEDGER_WORKFLOW_IDENTITY, {
      createIfMissing: false,
    });
    if (!loaded) return 'GitHub ledger diagnostic: comment absent.';
    return (
      `GitHub ledger diagnostic only: comment ${loaded.comment.id}, ` +
      `revision ${loaded.ledger.revision}.`
    );
  } catch (error) {
    return `GitHub ledger diagnostic unavailable: ${(error as Error).message}`;
  }
}

function hasNeedsHumanLabel(issue: GitHubIssueSummary): boolean {
  return (issue.labels ?? []).some(
    (label) =>
      (typeof label === 'string' ? label : label.name) === 'status:needs-human',
  );
}

interface SweepOutcome {
  issue: number;
  outcome: string;
  error?: string;
}

// Deterministic-rediscovery backstop for an orchestrator run that never
// reached its own runDispatchCanary catch block (job timeout, workflow
// cancellation, runner loss -- see STALE_CANARY_AGE_MS above). Lists every
// currently open issue (a single paginated, fully-consistent listing --
// deliberately not the Search API: github-api.ts's own discovery comment
// notes the epic design audit explicitly rejected full-text/marker search
// as a discovery mechanism because of search-index replication lag),
// filters to this canary's own title prefix plus marker, and for every
// candidate older than the threshold:
//   - closes it (with evidence) if its ledger shows a successful canary
//     completion -- the orchestrator verified success but never got to
//     call closeCanaryIssue itself. This applies whether or not the issue
//     was already parked status:needs-human (#527): a canary that timed
//     out and got parked, then had its generation complete successfully
//     moments later, must still recover -- parkCanaryFailure's own park is
//     not a terminal verdict, just the best evidence available at the time
//     it ran.
//   - otherwise, if not already parked, parks status:needs-human
//     (parkCanaryFailure).
//   - otherwise (already parked, still not successful), does nothing: a
//     duplicate park would re-post the "canary failed" comment and
//     re-verify the label/assignee on every single sweep pass for as long
//     as the ledger stays unresolved, and the issue is already carrying
//     the correct signal.
// A per-issue failure is recorded and reported but never blocks sweeping
// the remaining candidates -- each candidate's cleanup is independent, so
// they run concurrently rather than one at a time, bounded by
// CANARY_SWEEP_CONCURRENCY below (a "list every open issue" discovery pass
// can turn up a large stale backlog; an unbounded burst of simultaneous
// GitHub writes risks tripping secondary rate limits, per the same PR #374
// review finding ../main.ts's dispatchReconcileScan already applies this
// bound for).
async function sweepOneStaleCanary(
  api: GitHubApiClient,
  task: LedgerTaskRef,
  maintainer: string,
  alreadyParked: boolean,
): Promise<SweepOutcome> {
  const found = await findCanaryGeneration(
    task,
    undefined,
    (api as CanaryGitHubApiClient).taskStateFetch,
  );
  const conclusion = found?.generation?.attempt?.conclusion;
  if (found?.generation.state === 'completed' && conclusion === 'success') {
    assertCanaryContracts(found);
    await closeCanaryIssue(api, task, {
      generation: found.generation,
      message: alreadyParked
        ? '🧹 Swept by the scheduled canary janitor: this canary was ' +
          'previously parked status:needs-human after its orchestrator ' +
          'run never returned, but its dispatch broker ledger shows ' +
          `generation g${found.generation.generation} completed ` +
          'successfully since then. Recovering and closing.'
        : "🧹 Swept by the scheduled canary janitor: this canary's own " +
          'orchestrator run never returned (job timeout or workflow ' +
          'cancellation), but its dispatch broker ledger shows ' +
          `generation g${found.generation.generation} completed ` +
          'successfully. Closing.',
    });
    return {
      issue: task.issue,
      outcome: alreadyParked ? 'closed-after-late-success' : 'closed',
    };
  }
  if (alreadyParked) {
    return { issue: task.issue, outcome: 'already-parked' };
  }
  await parkCanaryFailure(
    api,
    task,
    maintainer,
    "Swept by the scheduled canary janitor: this canary's own " +
      'orchestrator run never returned (job timeout or workflow ' +
      'cancellation) and its dispatch broker ledger never reached ' +
      'a successful terminal state.',
  );
  return { issue: task.issue, outcome: 'parked' };
}

// See the comment above sweepOneStaleCanary for why this is bounded.
const CANARY_SWEEP_CONCURRENCY = 5;

interface SweepStaleCanariesOptions {
  now?: () => number;
  ageMs?: number;
}

async function sweepStaleCanaries(
  api: GitHubApiClient,
  repository: string,
  repositoryId: number,
  maintainer: string,
  {
    now = () => Date.now(),
    ageMs = STALE_CANARY_AGE_MS,
  }: SweepStaleCanariesOptions = {},
): Promise<SweepOutcome[]> {
  const root = repositoryPath({ repository });
  const openIssues = await listAll<GitHubIssueSummary>(
    api,
    `${root}/issues?state=open`,
  );
  const stale = openIssues.filter((issue) => {
    if (issue.pull_request) return false;
    if (!issue.title?.startsWith(CANARY_TITLE_PREFIX)) return false;
    const canonical = issue.body?.includes(CANARY_MARKER);
    const legacy = issue.body?.includes(LEGACY_CANARY_MARKER);
    if (!canonical && !legacy) return false;
    // A canonical issue may be years old and still healthy. Its current run
    // starts when prepareCanaryIssue updates/reopens it, whereas a legacy v1
    // issue was immutable after creation and keeps the old created-at clock.
    const activityAt = canonical
      ? (issue.updated_at ?? issue.created_at)
      : issue.created_at;
    const ageMsActual = now() - Date.parse(activityAt);
    return Number.isFinite(ageMsActual) && ageMsActual >= ageMs;
  });

  const outcomes = await mapWithConcurrency(
    stale,
    CANARY_SWEEP_CONCURRENCY,
    (issue) =>
      sweepOneStaleCanary(
        api,
        { repositoryId, repository, issue: issue.number },
        maintainer,
        hasNeedsHumanLabel(issue),
      ),
  );
  return outcomes.map((outcome, index) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : {
          issue: stale[index].number,
          outcome: 'error',
          // Assumed Error-shaped, exactly as ../main.ts's own
          // dispatchReconcileScan assumes for the same mapWithConcurrency
          // rejection shape.
          error: (outcome.reason as Error).message,
        },
  );
}

interface RunDispatchCanaryOptions {
  api: GitHubApiClient;
  repository: string;
  repositoryId: number;
  maintainer: string;
  source: string;
  runUrl: string;
  deployRunUrl?: string;
  liveUrl?: string;
  probeOptions?: ProbeLiveUrlOptions;
  pollOptions?: PollCanaryLedgerOptions;
  callerId?: string;
}

async function runDispatchCanary({
  api,
  repository,
  repositoryId,
  maintainer,
  source,
  runUrl,
  deployRunUrl,
  liveUrl,
  probeOptions = {},
  pollOptions = {},
  callerId = randomUUID(),
}: RunDispatchCanaryOptions): Promise<{ issue: number }> {
  if (liveUrl) {
    const probe = await probeLiveUrl(liveUrl, probeOptions);
    if (!probe.ok) {
      // No canary issue exists yet to attach evidence to; create one so
      // this failure gets the same anchored, needs-human-parked audit
      // trail as every other broker failure instead of a silent log line.
      // A broken deploy is not the broker's fault, so the canary dispatch
      // itself is deliberately skipped -- it would only be misleading.
      const issue = await prepareCanaryIssue(api, repository, {
        source,
        runUrl,
        deployRunUrl,
      });
      const task = { repositoryId, repository, issue: issue.number };
      const reason = `Live URL probe failed for ${liveUrl}: ${probe.reason}`;
      await parkCanaryFailure(api, task, maintainer, reason);
      throw new Error(`Post-deploy smoke: ${reason}`);
    }
  }

  const issue = await prepareCanaryIssue(api, repository, {
    source,
    runUrl,
    deployRunUrl,
  });
  const task = { repositoryId, repository, issue: issue.number };

  try {
    const routerRun = await dispatchRouterCanary(
      api,
      repository,
      issue.number,
      callerId,
    );
    console.log(`::notice::canary router dispatched: ${routerRun.htmlUrl}`);
    const result = await pollCanaryLedger(api, task, {
      ...pollOptions,
      sourceId: callerId,
    });
    const conclusion = result.generation?.attempt?.conclusion;
    if (result.rejected || conclusion !== 'success') {
      throw new Error(
        `Canary dispatch generation g${result.generation?.generation} ended ` +
          `in state '${result.generation?.state}'` +
          (conclusion ? ` with conclusion '${conclusion}'` : '') +
          '.',
      );
    }
    assertCanaryContracts(result);
    await closeCanaryIssue(api, task, {
      generation: result.generation,
      runUrl,
    });
    return { issue: issue.number };
  } catch (error) {
    const diagnostic = await ledgerCommentDiagnostic(api, task);
    await parkCanaryFailure(
      api,
      task,
      maintainer,
      `${(error as Error).message} ${diagnostic}`,
    );
    throw error;
  }
}

async function main(): Promise<void> {
  const api = createGitHubApi({ token: env('GITHUB_TOKEN') });
  const repository = env('GITHUB_REPOSITORY');
  const repositoryId = Number(env('GITHUB_REPOSITORY_ID'));
  const maintainer = env('MAINTAINER_LOGIN');
  const source = env('CANARY_SOURCE');
  const runUrl = `${env('GITHUB_SERVER_URL')}/${repository}/actions/runs/${env('GITHUB_RUN_ID')}`;
  const deployRunUrl = env('DEPLOY_RUN_URL', false);
  const liveUrl = env('LIVE_URL', false);
  const sweepStale = env('SWEEP_STALE', false) === 'true';

  // The sweep is entirely best-effort with respect to the primary canary
  // below: a listing failure (e.g. a transient GitHub API error) is caught
  // here, not just a per-issue failure inside sweepStaleCanaries itself, so
  // an unhealthy janitor pass can never prevent this run's own primary
  // canary from creating, dispatching, and verifying. Any sweep problem is
  // still surfaced loudly -- just after the primary result, never instead
  // of it.
  let sweepError: Error | undefined;
  if (sweepStale) {
    try {
      const swept = await sweepStaleCanaries(
        api,
        repository,
        repositoryId,
        maintainer,
      );
      const sweepFailures = swept.filter((entry) => entry.outcome === 'error');
      for (const entry of swept) {
        const marker = entry.outcome === 'error' ? '::error::' : '::notice::';
        const detail = entry.error ? ` (${entry.error})` : '';
        console.log(
          `${marker}canary janitor: #${entry.issue} ${entry.outcome}${detail}`,
        );
      }
      if (sweepFailures.length > 0) {
        sweepError = new Error(
          `Canary janitor sweep failed for ${sweepFailures.length} issue(s): ` +
            sweepFailures.map((entry) => `#${entry.issue}`).join(', '),
        );
      }
    } catch (error) {
      console.log(
        `::error::canary janitor sweep aborted: ${(error as Error).message}`,
      );
      sweepError = error as Error;
    }
  }

  const result = await runDispatchCanary({
    api,
    repository,
    repositoryId,
    maintainer,
    source,
    runUrl,
    deployRunUrl,
    liveUrl,
  });
  await output('issue', String(result.issue));

  // The primary canary lifecycle above always gets to run and report its
  // own outcome first; a sweep failure still fails this job loud afterward
  // rather than silently -- cleanup failure is itself a red required job,
  // same convention as the primary canary's own parkCanaryFailure path.
  if (sweepError) throw sweepError;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

export {
  assertCanaryContracts,
  CANARY_SWEEP_CONCURRENCY,
  closeCanaryIssue,
  dispatchRouterCanary,
  issueBody,
  LEDGER_POLL_TIMEOUT_MS,
  parkCanaryFailure,
  pollCanaryLedger,
  prepareCanaryIssue,
  probeLiveUrl,
  runDispatchCanary,
  STALE_CANARY_AGE_MS,
  sweepStaleCanaries,
};
