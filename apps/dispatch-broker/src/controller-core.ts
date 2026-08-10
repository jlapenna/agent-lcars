import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  DispatchLedger,
  DispatchPipeline,
  FailurePhase,
  LedgerGeneration,
  LedgerTaskRef,
  OwningSystem,
} from '@agent-lcars/dispatch-contracts';
import {
  classifyFailure,
  displayTitleMatchesAttempt,
  formatAttemptId,
  formatFailure,
} from '@agent-lcars/dispatch-contracts';
import type { ReconcileIssue } from '@agent-lcars/dispatch-reconcile';
import {
  discoverRecentlyClosedReconcileCandidates as discoverRecentlyClosedReconcileCandidatesShared,
  discoverReconcileCandidates as discoverReconcileCandidatesShared,
  dispatchReconcileScan as dispatchReconcileScanShared,
  RECONCILE_DISPATCH_CONCURRENCY,
  runReconcileScan,
} from '@agent-lcars/dispatch-reconcile';

import type { AnchorControl } from './broker';
import {
  abandonPendingLaunchForClosedAnchor,
  acceptIntent,
  ACTIVE_STATES,
  addAnomaly,
  applyAnchorControl,
  awaitTerminal,
  beginDispatch,
  bindRun,
  completeRun,
  createLedger,
  markDispatchRejected,
  markDispatchUnknown,
  observeCompletion,
  recordControlEvidence,
  recordOutcome,
  restoreAcceptedForLaunchRetry,
  verifyPreflight,
} from './broker';
import {
  classifyClaudeReadiness,
  type ClaudeReadinessState,
} from './claude-readiness';
import {
  classifyAuthorityTaskInitialization,
  createGitHubApi,
  createReconcileTransport,
  dispatchWorker,
  ensureLaneReadinessAlert,
  failClosed,
  findRunsForGeneration,
  findSupersedingRouterRun,
  getWorkflowRun,
  GitHubApiError,
  type LedgerProjectionIdentity,
  listAll,
  loadLedgerProjection,
  pinLedgerWhenUnoccupied,
  readLaneReadiness,
  repositoryPath,
  resolveLaneReadinessAlerts,
  saveLedger as saveLedgerComment,
  verifyBrokerConcurrency,
  workerWorkflow,
} from './github-api';
import { sendHostedCompletion } from './hosted-completion-client';
import type { Intent } from './modules/intent';
import {
  MISSING_RUN_GRACE_MS as RECONCILE_MISSING_RUN_GRACE_MS,
  MISSING_RUN_MAX_OBSERVATIONS as RECONCILE_MISSING_RUN_MAX_ATTEMPTS,
  MISSING_RUN_MIN_INTERVAL_MS as RECONCILE_MISSING_RUN_MIN_INTERVAL_MS,
  reconcileExecution,
  STUCK_RUN_GRACE_MS as RECONCILE_STUCK_RUN_GRACE_MS,
  STUCK_RUN_MAX_OBSERVATIONS as RECONCILE_STUCK_RUN_MAX_ATTEMPTS,
  STUCK_RUN_MIN_INTERVAL_MS as RECONCILE_STUCK_RUN_MIN_INTERVAL_MS,
} from './modules/outcome-finalizer';
import {
  projectComment,
  projectNeedsHumanPark,
  recordProjectionStatus,
  removeIssueLabel,
} from './modules/projector';
import type { PreflightExpectation } from './modules/scheduler';
import type {
  AnchorControlEvent,
  CompletionEvent,
  NormalizeContext,
  NormalizedEvent,
} from './normalize';
import {
  makeIntent,
  normalizeEvent,
  quickTaskRequest,
  REVIEW_LABELS,
  selectedPipeline,
  selectedPipelineFrom,
} from './normalize';
import { processCompletionCallback } from './services/completion-processing';
import { admitHostedDelivery } from './services/hosted-admission';
import { orchestrateReconciliation } from './services/reconciliation-orchestration';
import {
  acquireAuthority,
  type AuthoritySession,
  AuthorityStateMissingError,
  AuthorityStateNotFoundError,
  persistAuthority,
  releaseAuthority,
  TaskLeaseBusyError,
} from './storage/authority';
import { FirestoreRestStoragePort } from './storage/firestore-rest-port';
import type { LaunchOutboxOperation, StoragePort } from './storage/port';

// --- GitHub webhook/REST shapes main.mjs reads. One set covering every
// endpoint this file calls: the raw event payload off disk (normalize()),
// issue/comment/timeline REST responses, and workflow run details. ---

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

interface GitHubTimelineEvent {
  event?: string;
  label?: { name?: string };
  actor?: GitHubUserRef;
  created_at: string;
  id?: number;
}

/** The raw `GITHUB_EVENT_PATH` payload -- one shape covering every
 *  `eventName` this action handles, exactly as the untyped original read
 *  it. `inputs` is only present for `workflow_dispatch`. */
interface GitHubEventPayload {
  repository?: { full_name: string; id: number };
  inputs?: Record<string, string>;
  action: string;
  issue?: GitHubIssueDetail;
  pull_request?: GitHubIssueDetail;
  comment?: GitHubIssueComment;
  sender?: GitHubUserRef;
  label?: GitHubLabelRef;
}

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

interface GitHubApiRequestOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
}

/** `createGitHubApi()`'s return shape -- see github-api.mjs. `requestOk` is
 *  generic because its return shape is entirely endpoint-dependent; each
 *  call site here names the shape it expects. */
interface GitHubApiClient {
  request: (
    path: string,
    options?: GitHubApiRequestOptions,
  ) => Promise<{ status: number; data: unknown; headers: Headers }>;
  requestOk: <T = unknown>(
    path: string,
    options?: GitHubApiRequestOptions,
  ) => Promise<T>;
}

/** `loadLedger()`/`loadBrokerLedger()`'s return shape -- the ledger paired
 *  with the GitHub comment carrying it. */
interface LoadedLedger {
  ledger: DispatchLedger;
  comment: GitHubIssueComment;
  created: boolean;
  existingComments?: GitHubIssueComment[];
  authority?: AuthoritySession;
  projectionAvailable?: boolean;
}

interface LedgerContext {
  client: GitHubApiClient;
  loaded: LoadedLedger;
}

function env(name: string, required = true): string {
  const value = process.env[name];
  if (required && !value) throw new Error(`${name} is required`);
  return value ?? '';
}

function output(name: string, value: unknown): Promise<void> {
  const path = env('GITHUB_OUTPUT');
  return fs.appendFile(path, `${name}=${value}\n`, 'utf8');
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decode(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function api(): GitHubApiClient {
  return createGitHubApi({ token: env('GITHUB_TOKEN') });
}

// The Action adapter's one `FirestoreRestStoragePort` factory. Every broker
// transition acquires the shared per-task authority lease before changing
// controller state. Credential resolution stays out of the adapter itself
// (firestore-rest-port.ts's own "Auth" section): agent-router.yml's
// google-github-actions/auth step mints the access token and this file only
// ever reads the resulting env var, never derives one itself.
function createStoragePort(): StoragePort {
  return new FirestoreRestStoragePort({
    projectId: env('GCP_PROJECT_ID'),
    databaseId: env('DISPATCH_FIRESTORE_DATABASE_ID'),
    token: env('DISPATCH_STORAGE_TOKEN'),
  });
}

async function saveLedger(
  client: GitHubApiClient,
  loaded: LoadedLedger,
): Promise<void> {
  if (!loaded.authority) {
    await saveLedgerComment(client, loaded);
    return;
  }
  if (loaded.projectionAvailable === false) {
    recordProjectionStatus(loaded.ledger, false);
    await persistAuthority(loaded.authority, loaded.ledger);
    return;
  }
  await persistAuthority(loaded.authority, loaded.ledger);
  try {
    await saveLedgerComment(client, loaded);
  } catch (error) {
    loaded.projectionAvailable = false;
    recordProjectionStatus(loaded.ledger, false);
    await persistAuthority(loaded.authority, loaded.ledger);
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `::warning::Dispatch state committed to Firestore, but its GitHub ` +
        `ledger projection failed: ${message}`,
    );
  }
}

async function saveProjectionCheckpoint(
  client: GitHubApiClient,
  loaded: LoadedLedger,
): Promise<void> {
  if (!loaded.authority) {
    recordProjectionStatus(loaded.ledger, true);
    await saveLedger(client, loaded);
    return;
  }
  if (loaded.projectionAvailable === false) {
    recordProjectionStatus(loaded.ledger, false);
    await persistAuthority(loaded.authority, loaded.ledger);
    return;
  }

  const beforeProjection = loaded.ledger;
  const converged = structuredClone(beforeProjection);
  recordProjectionStatus(converged, true);
  loaded.ledger = converged;
  try {
    await saveLedgerComment(client, loaded);
  } catch (error) {
    loaded.ledger = beforeProjection;
    recordProjectionStatus(loaded.ledger, false);
    await persistAuthority(loaded.authority, loaded.ledger);
    throw error;
  }
  await persistAuthority(loaded.authority, loaded.ledger);
}

function contextFor(
  event: GitHubEventPayload,
  inputs: Record<string, string>,
): NormalizeContext {
  return {
    repository: event.repository?.full_name ?? env('GITHUB_REPOSITORY'),
    repositoryId: event.repository?.id ?? Number(env('GITHUB_REPOSITORY_ID')),
    issue: inputs.issue,
    runId: Number(env('GITHUB_RUN_ID')),
    actor: env('GITHUB_ACTOR'),
    now: new Date().toISOString(),
  };
}

// Module failure isolation (#645 Phase 2): wraps one fallible controller
// step so its own exception is classified by phase, recorded, and only THEN
// rethrown. Before this, a module's throw (the concrete regression: a Quick
// Task digest mismatch crashing the entire signal-normalization step) had no
// attributed cause anywhere -- it just propagated as a bare, unclassified
// exception until something outside the controller (the Actions job itself)
// finally failed on it.
//
// This does not change fail-closed behavior: `step()`'s own exception is
// always what gets rethrown, unchanged, once recording is attempted. It only
// adds a classified, attributed record of the failure before that happens.
//
// Recording has two independent layers:
//  - a GitHub Actions `::error::` annotation carrying `formatFailure(...)`,
//    always emitted. This is the one record that survives when no ledger
//    could be loaded at all -- the failure may be *why* it couldn't load
//    (normalize() runs before any ledger exists for this event at all; see
//    its own call below), so this can never depend on ledger availability.
//  - a classified ledger anomaly, only when `ledgerContext` (a
//    `{ client, loaded }` pair) is supplied, i.e. only from within broker(),
//    the one serialized job allowed to write the ledger.
//
// A failure in EITHER recording layer must never replace or swallow the
// original error -- the failure that triggered recording may be exactly why
// recording itself fails (a broken client, a ledger that can no longer be
// saved). Both layers are therefore independently best-effort: the
// annotation write can't meaningfully fail, and a `saveLedger` failure here
// is caught, logged as its own secondary `::error::`, and discarded rather
// than thrown.
//
// `reason: 'internal_error'` / `retryDisposition: 'manual'` are the generic,
// conservative pairing already used elsewhere in this file (see
// reconcileActive's duplicate-attempt anomaly and reconcileLedger's
// invariant-violation anomaly) for exactly this situation: an exception this
// generic wrapper catches by construction cannot know a step's own specific
// FAILURE_REASONS code, and guessing one from the error message would risk
// exactly the "typo'd reason code that silently reaches a dashboard" failure.js
// warns against. The `phase` -- always caller-supplied, never guessed -- is
// what makes this still useful: every failure it catches is at least
// attributed to which controller step produced it.
//
// `owningSystem` defaults to `'controller'`, matching every call site below
// unchanged (all six omit it) -- this repo's own controller phases
// (signal/authorization/intent/scheduling/launch/reconciliation) are all
// genuinely controller-owned, including `reconciliation`, whose default
// `classifyFailure` refuses to infer (see failure.ts's `PHASE_OWNERS`
// comment) and which is exactly why this wrapper has always passed an
// explicit value here rather than omitting it. #645 Phase 4 reuses this same
// wrapper for the projector's own `reporting`-phase failures (see
// modules/projector.ts's header comment on why it does not build a second,
// parallel classify/record/rethrow mechanism of its own) by passing
// `'projector'` explicitly at those call sites -- this parameter is what
// makes that reuse correct instead of misattributing a projection failure to
// the controller.
async function runPhase<T>(
  ledgerContext: LedgerContext | undefined,
  phase: FailurePhase,
  step: () => T | Promise<T>,
  owningSystem: OwningSystem = 'controller',
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = classifyFailure({
      phase,
      owningSystem,
      reason: 'internal_error',
      retryDisposition: 'manual',
      detail: message,
    });
    console.log(`::error::${formatFailure(failure)}: ${message}`);
    if (ledgerContext) {
      try {
        addAnomaly(
          ledgerContext.loaded.ledger,
          'phase-failure',
          { phase, message },
          undefined,
          failure,
        );
        await saveLedger(ledgerContext.client, ledgerContext.loaded);
      } catch (recordingError) {
        const recordingMessage =
          recordingError instanceof Error
            ? recordingError.message
            : String(recordingError);
        console.log(
          `::error::Failed to record the above ${phase} phase failure to ` +
            `the dispatch ledger: ${recordingMessage}`,
        );
      }
    }
    throw error;
  }
}

async function normalize(): Promise<void> {
  // This is an Action-only path; the hosted route imports
  // processNormalizedEvent and never reads the runner event file.
  const event: GitHubEventPayload = JSON.parse(
    await fs.readFile(
      /* turbopackIgnore: true */ env('GITHUB_EVENT_PATH'),
      'utf8',
    ),
  );
  const eventName = env('GITHUB_EVENT_NAME');
  const inputs: Record<string, string> = event.inputs ?? {};
  const context = contextFor(event, inputs);
  const client = api();
  if (eventName === 'workflow_dispatch') {
    const issue = await client.requestOk<GitHubIssueDetail>(
      `${repositoryPath({ repository: context.repository })}/issues/${inputs.issue}`,
    );
    event.issue = issue;
  }
  let timeline: GitHubTimelineEvent[] = [];
  // The Issue Timeline API also covers pull requests (a PR number IS an
  // issue number under the hood), so a pull_request_target labeled/unlabeled
  // event
  // -- the review-dispatch counterpart to an issue's labeled/unlabeled --
  // needs the same timeline fetch normalizeEvent's timelineSource() relies
  // on to disambiguate which delivery this webhook is. The target event is
  // required here because it runs this privileged controller from trusted
  // main rather than from a PR-controlled merge ref. Its own closed/reopened
  // actions don't need the timeline: normalizeEvent resolves their sourceId
  // directly from the payload.
  const wantsTimeline =
    (eventName === 'issues' &&
      ['labeled', 'unlabeled', 'closed', 'reopened'].includes(event.action)) ||
    (['pull_request', 'pull_request_target'].includes(eventName) &&
      ['labeled', 'unlabeled'].includes(event.action));
  if (wantsTimeline) {
    // wantsTimeline is only true for an issue or pull-request event, each of
    // which always carries one of the two -- recomputed independently here
    // exactly as the original did.
    const numbered = event.issue ?? event.pull_request;
    if (!numbered) {
      throw new Error(
        `Event ${eventName}/${event.action} claimed a timeline but carried neither issue nor pull_request`,
      );
    }
    timeline = await client.requestOk<GitHubTimelineEvent[]>(
      `${repositoryPath({ repository: context.repository })}/issues/${numbered.number}/timeline?per_page=100`,
    );
  }
  // No ledger exists yet at this point in the workflow -- normalize() runs
  // in its own job, before broker() ever loads (or creates) one -- so
  // `ledgerContext` is always undefined here. A throw from normalizeEvent()
  // (the concrete regression: a Quick Task digest mismatch, see
  // quickTaskRequest in normalize.mjs) is still classified as a `signal`
  // phase failure and surfaced via the `::error::` annotation before it
  // fails this job closed, rather than propagating as a bare, unattributed
  // crash.
  const normalized = await runPhase(undefined, 'signal', () =>
    normalizeEvent({
      eventName,
      event,
      inputs,
      context,
      timeline,
      maintainer: env('MAINTAINER_LOGIN'),
    }),
  );
  // Only some NormalizedEvent kinds carry `task`/`reason` at all; the `in`
  // checks are the typed equivalent of the original's bare optional-chained
  // property reads on a dynamically-shaped object.
  const normalizedTask = 'task' in normalized ? normalized.task : undefined;
  const normalizedReason =
    'reason' in normalized ? normalized.reason : undefined;
  const issue =
    normalizedTask?.issue ?? event.issue?.number ?? Number(inputs.issue);
  await output('eligible', normalized.kind === 'ignored' ? 'false' : 'true');
  await output('issue', String(issue || ''));
  await output('repository-id', String(context.repositoryId));
  await output(
    'is-pr',
    String(Boolean(event.pull_request ?? event.issue?.pull_request)),
  );
  await output(
    'group',
    issue
      ? `agent-lcars-dispatch-v1-${context.repositoryId}-${issue}`.toLowerCase()
      : '',
  );
  await output('payload', encode(normalized));
  await output('reason', normalizedReason ?? '');
}

function activeGeneration(
  ledger: DispatchLedger,
): LedgerGeneration | undefined {
  return ledger.generations.find((generation) =>
    ACTIVE_STATES.has(generation.state),
  );
}

function assertWorkerRun(
  run: WorkflowRun,
  task: LedgerTaskRef,
  generation: LedgerGeneration,
  expectedWorkflow: string,
): void {
  if (
    run.repository?.id !== task.repositoryId ||
    run.event !== 'workflow_dispatch' ||
    run.path !== `.github/workflows/${expectedWorkflow}` ||
    !displayTitleMatchesAttempt(run.display_title, generation)
  ) {
    throw new Error('Worker run identity does not match its ledger binding');
  }
}

async function reconcileActive(
  client: GitHubApiClient,
  loaded: LoadedLedger,
  now: string = new Date().toISOString(),
  maintainer = '',
): Promise<void> {
  let active = activeGeneration(loaded.ledger);
  if (!active) return;
  const expectedWorkflow = workerWorkflow(active.pipeline);
  const matchingRuns: WorkflowRun[] = await findRunsForGeneration(
    client,
    loaded.ledger.task,
    active,
  );
  if (matchingRuns.length > 1) {
    addAnomaly(
      loaded.ledger,
      'duplicate-attempt',
      {
        generation: active.generation,
        runIds: matchingRuns.map((run) => run.id),
      },
      undefined,
      // The reconciler is what noticed this, but the state that is wrong --
      // "at most one worker run bound to a generation" -- is the ledger's
      // own invariant, so the controller (its state authority) owns it, not
      // whichever of the two GitHub Actions runs happens to be the
      // duplicate. No reason code in the vocabulary names "two runs matched
      // one generation" specifically (#645's audit table never hit this
      // case), so this falls back to `internal_error`, the vocabulary's own
      // catch-all for exactly that gap. `never`, not `manual`: re-running
      // the broker on the next event re-derives the same duplicate-run
      // snapshot and throws again -- retrying cannot resolve it, and
      // dispatching a fresh attempt to "fix" it would only add a third
      // duplicate. Only a human fixing the underlying divergence (cancel a
      // run, or correct the ledger) out of band lets the next reconcile
      // pass see a clean state again.
      classifyFailure({
        phase: 'reconciliation',
        owningSystem: 'controller',
        reason: 'internal_error',
        retryDisposition: 'never',
      }),
    );
    await saveLedger(client, loaded);
    throw new Error('Multiple worker runs match one dispatch generation');
  }
  if (
    ['dispatching', 'dispatch-unknown'].includes(active.state) &&
    matchingRuns.length === 1
  ) {
    const run = matchingRuns[0];
    assertWorkerRun(run, loaded.ledger.task, active, expectedWorkflow);
    bindRun(loaded.ledger, active.generation, {
      runId: run.id,
      runUrl: run.url,
      htmlUrl: run.html_url,
      workflow: expectedWorkflow,
    });
    await saveLedger(client, loaded);
    active = activeGeneration(loaded.ledger);
  }
  if (!active?.attempt?.runId) return;
  const run: WorkflowRun = await getWorkflowRun(
    client,
    loaded.ledger.task,
    active.attempt.runId,
  );
  assertWorkerRun(run, loaded.ledger.task, active, expectedWorkflow);
  await resolvePendingLaunchAsLaunchedBestEffort(loaded, active, {
    runId: run.id,
    runUrl: run.url,
    htmlUrl: run.html_url,
  });
  const execution = reconcileExecution({
    attempt: {
      dispatchStartedAt: active.attempt.dispatchStartedAt ?? active.occurredAt,
      boundAt: active.attempt.boundAt,
      runId: active.attempt.runId,
    },
    run: {
      status: run.status,
      conclusion: run.conclusion,
      updatedAt: run.updated_at,
    },
    now,
    priorObservations: reconcileAnomaliesFor(
      loaded.ledger,
      active.generation,
      'reconcile-stuck-run',
    ),
  });
  if (execution.action === 'finalize') {
    // Cancelled and timed-out runs land here too -- GitHub reports
    // `status: 'completed'` regardless of `conclusion`, so a cancellation or
    // a timeout terminalizes out-of-band the same as any other outcome, with
    // no dependence on the worker's own callback ever arriving.
    completeRun(loaded.ledger, active.generation, {
      runId: run.id,
      status: run.status,
      conclusion: run.conclusion,
      completedAt: run.updated_at,
    });
    await saveLedger(client, loaded);
    return;
  }
  // The other half of #645's out-of-band terminalization gap: a run IS
  // bound (unlike trackMissingRun's case below) but GitHub has never once
  // reported it terminal. trackStuckRun applies the same bounded
  // observation-and-escalation shape to that case.
  await trackStuckRun(client, loaded, active, run, now, maintainer);
}

// The reconciler's (#305) grace period before a still-runless dispatching
// generation is flagged at all -- `findRunsForGeneration` can legitimately
// see zero matches for a few seconds/minutes right after a genuine dispatch
// (ordinary eventual consistency, the same lag #340 documented for
// concurrency-group listings), so the FIRST reconcile pass over a young
// generation must stay a silent no-op.
// Minimum gap between two COUNTED missing-run observations for the same
// generation. This is what makes a reconcile pass idempotent against a
// second, overlapping, or rapidly re-triggered pass (the acceptance
// criterion): re-observing "still missing" inside this window records
// nothing new and mutates nothing, rather than inflating the attempt
// counter or re-writing the ledger. A genuinely new scheduled pass (30
// minutes later, see dispatch-reconcile.yml) always clears it.
// Bound on how many distinct, interval-separated "still missing" reconcile
// observations a generation gets before it is parked needs-human. Mirrors
// the repo's general bounded-retry posture (#343/#344) rather than
// retrying forever.
const CLOSED_ANCHOR_LAUNCH_REJECTION =
  'anchor closed before launch was observed';

function reconcileAnomaliesFor(
  ledger: DispatchLedger,
  generationNumber: number,
  kind: string,
) {
  return ledger.anomalies.filter(
    (anomaly) =>
      anomaly.kind === kind &&
      // `detail` is deliberately untyped on LedgerAnomaly (each kind owns
      // its own shape) -- every `addAnomaly` call below that records one of
      // these two kinds always includes a numeric `generation` field.
      (anomaly.detail as { generation?: number } | undefined)?.generation ===
        generationNumber,
  );
}

async function readLaunchOperationForReconciliation(
  loaded: LoadedLedger,
  attemptId: string,
): Promise<
  { ok: true; operation: LaunchOutboxOperation | undefined } | { ok: false }
> {
  if (!loaded.authority) return { ok: true, operation: undefined };
  try {
    return {
      ok: true,
      operation: await loaded.authority.port.readLaunchOperation(attemptId),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `::warning::Deferring launch reconciliation for ${attemptId} until ` +
        `its outbox record can be read: ${message}`,
    );
    return { ok: false };
  }
}

// Repairs orphan classes 2 and 4 from #305's production audit: a dispatch
// whose POST outcome was genuinely lost (queue-evicted per #345/#347, or a
// worker that crashed before ever registering a matching run) leaves a
// generation stuck `dispatching`/`dispatch-unknown` forever with no run ID
// -- reconcileActive() above already binds it the instant exactly one
// matching run appears, but does nothing when zero ever do. This is the one
// gap reconcileActive() cannot safely close itself: a single event-driven
// broker() call has no concept of "how many times has this now been
// observed missing" and must not escalate straight to needs-human on one
// possibly-premature zero-match observation -- reconcileActive() itself
// runs unconditionally on every single event, so it cannot be the thing
// that counts a bounded number of attempts over time.
//
// Every mutation here is recorded in the ledger's `anomalies` array before
// (successful) escalation and is itself idempotent: the leading
// 'reconcile-parked' check below short-circuits every later pass into a
// true no-op once the bound is hit, and the age/interval gates prevent
// double-counting a rapid re-run.
async function trackMissingRun(
  client: GitHubApiClient,
  loaded: LoadedLedger,
  generation: LedgerGeneration,
  now: string,
  maintainer: string,
): Promise<void> {
  const ledger = loaded.ledger;
  if (
    reconcileAnomaliesFor(ledger, generation.generation, 'reconcile-parked')
      .length > 0
  ) {
    return;
  }
  const priorObservations = reconcileAnomaliesFor(
    ledger,
    generation.generation,
    'reconcile-missing-run',
  );
  const decision = reconcileExecution({
    attempt: {
      dispatchStartedAt:
        generation.attempt?.dispatchStartedAt ?? generation.occurredAt,
    },
    now,
    priorObservations,
  });
  if (decision.action === 'wait' || decision.action === 'finalize') return;
  const { ageMs } = decision;
  const attempt = decision.observation;
  const reachedBound = decision.action === 'escalate';
  const attemptId =
    generation.attempt?.attemptId ?? formatAttemptId(generation);
  const launchRead =
    reachedBound && loaded.authority
      ? await readLaunchOperationForReconciliation(loaded, attemptId)
      : { ok: true as const, operation: undefined };
  if (!launchRead.ok) return;
  const launchOperation = launchRead.operation;
  const retryPendingLaunch = Boolean(
    !ledger.control.closed &&
    launchOperation?.status === 'pending' &&
    launchOperation.operationId === attemptId &&
    launchOperation.attemptId === attemptId,
  );
  const abandonClosedLaunch = Boolean(
    ledger.control.closed &&
    launchOperation?.operationId === attemptId &&
    launchOperation.attemptId === attemptId &&
    (launchOperation.status === 'pending' ||
      (launchOperation.resolution?.status === 'rejected' &&
        launchOperation.resolution.reason === CLOSED_ANCHOR_LAUNCH_REJECTION)),
  );
  // Computed up front, once, so the park gate below and the
  // 'reconcile-parked' anomaly further down share exactly one description
  // of "why parked" rather than two independently-written literals that
  // could drift. Exhausting the retry budget doesn't change *why* the run
  // went missing, only that automated backoff has given up on it, so
  // `retryDisposition` moves from `backoff` (the 'reconcile-missing-run'
  // observation below) to `manual` while `reason` stays
  // `launch_response_lost`. `undefined` when the bound has not been
  // reached -- there is nothing to park yet.
  const parkFailure =
    reachedBound && !retryPendingLaunch && !abandonClosedLaunch
      ? classifyFailure({
          phase: 'reconciliation',
          owningSystem: 'controller',
          reason: 'launch_response_lost',
          retryDisposition: 'manual',
          evidence: `${RECONCILE_MISSING_RUN_MAX_ATTEMPTS} bounded reconcile-missing-run observations exhausted for generation ${generation.generation}`,
        })
      : undefined;
  if (abandonClosedLaunch && launchOperation?.status === 'pending') {
    try {
      await loaded.authority?.port.resolveLaunchOutcome(attemptId, {
        status: 'rejected',
        reason: CLOSED_ANCHOR_LAUNCH_REJECTION,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        `::warning::Deferring closed-anchor launch abandonment for ` +
          `${attemptId} until its outbox record can be resolved: ${message}`,
      );
      return;
    }
  }
  // Apply the (idempotent, verify-then-decide) GitHub-side park BEFORE
  // recording it in the ledger: if the mutation throws, the ledger must
  // stay exactly as it was so the next pass retries at the same attempt
  // count, rather than claiming a park that never actually landed. Routed
  // through the projector's own needsMaintainer gate (#645 Phase 4) rather
  // than calling ensureNeedsHumanParked directly -- parkFailure's `manual`
  // disposition always satisfies that gate here, so this changes nothing
  // observable; it is now the projector, not this reconciler, that owns
  // the needs-human decision.
  if (parkFailure) {
    await projectNeedsHumanPark(client, ledger.task, maintainer, parkFailure);
  }
  addAnomaly(
    ledger,
    'reconcile-missing-run',
    {
      generation: generation.generation,
      intentId: generation.intentId,
      pipeline: generation.pipeline,
      state: generation.state,
      attempt,
      ageMs,
    },
    now,
    // A `dispatching`/`dispatch-unknown` generation with no bound run after
    // its grace period is the delayed confirmation of exactly what
    // `dispatch-unknown`/`markDispatchUnknown` already names: the
    // controller does not know whether its own dispatch POST landed. That
    // makes the controller the owning system even though one of the two
    // root causes #305's audit named (a worker crashing before ever
    // registering) is technically a worker failure -- the ledger state
    // being reconciled here is the controller's own bookkeeping, and the
    // reconciler cannot distinguish the two causes from a bare zero-match
    // observation. `backoff`, not `manual`: this is still inside the
    // bounded-retry window (`RECONCILE_MISSING_RUN_MAX_ATTEMPTS`) --
    // trackMissingRun's own next scheduled pass, at least
    // `RECONCILE_MISSING_RUN_MIN_INTERVAL_MS` later, is the retry, and
    // `retryBudget` mirrors the attempts this same counter has left before
    // `reconcile-parked` (below) takes over.
    classifyFailure({
      phase: 'reconciliation',
      owningSystem: 'controller',
      reason: 'launch_response_lost',
      retryDisposition: 'backoff',
      retryBudget: decision.retryBudget,
      evidence: `no worker run bound to generation ${generation.generation} ${ageMs}ms after dispatch (observation ${attempt}/${RECONCILE_MISSING_RUN_MAX_ATTEMPTS})`,
    }),
  );
  if (retryPendingLaunch) {
    addAnomaly(
      ledger,
      'reconcile-launch-retry',
      {
        generation: generation.generation,
        intentId: generation.intentId,
        operationId: attemptId,
        reason: 'pending-launch-outbox-bound-exhausted',
      },
      now,
      classifyFailure({
        phase: 'reconciliation',
        owningSystem: 'controller',
        reason: 'launch_response_lost',
        retryDisposition: 'immediate',
        retryBudget: 1,
        evidence:
          `the exact launch outbox operation ${attemptId} is still pending ` +
          `after ${RECONCILE_MISSING_RUN_MAX_ATTEMPTS} bounded searches found no matching workflow run`,
      }),
    );
    restoreAcceptedForLaunchRetry(ledger, generation.generation, now);
    await saveLedger(client, loaded);
    return;
  }
  if (abandonClosedLaunch) {
    addAnomaly(
      ledger,
      'reconcile-launch-abandoned',
      {
        generation: generation.generation,
        intentId: generation.intentId,
        operationId: attemptId,
        reason: 'anchor-closed-before-launch-observed',
      },
      now,
    );
    abandonPendingLaunchForClosedAnchor(
      ledger,
      generation.generation,
      CLOSED_ANCHOR_LAUNCH_REJECTION,
      now,
    );
    await saveLedger(client, loaded);
    return;
  }
  if (parkFailure) {
    addAnomaly(
      ledger,
      'reconcile-parked',
      {
        generation: generation.generation,
        reason: 'missing-run-bound-exhausted',
      },
      now,
      // The genuine human handoff: `projectNeedsHumanPark` (above) has
      // just run, and the guard at the top of this function turns every
      // later pass into a no-op, so nothing further happens automatically.
      parkFailure,
    );
  }
  await saveLedger(client, loaded);
}

// The grace period before a BOUND-but-non-terminal run is even considered
// for escalation (#645 Phase 3) -- must exceed the longest legitimate run,
// or this watchdog fires on healthy work, which is worse than no watchdog.
// The three worker workflows' own job-level `timeout-minutes` are GitHub's
// own server-side backstop on how long a run can legitimately stay
// non-terminal: claude.yml and codex.yml are both 90, opencode.yml is 135
// (the largest). On top of that: queue time before a self-hosted runner
// picks up the dispatched job at all (the runner-autoscaler's own
// documented worst case is its hour-long DRAIN_TIMEOUT_SECONDS host-drain
// window) and a margin for GitHub's own status-reporting lag once a run
// genuinely ends. 135 + 60 + 45 rounds to a clean 4 hours.
// Minimum gap between two COUNTED stuck-run observations for the same
// generation -- identical idempotence purpose to
// RECONCILE_MISSING_RUN_MIN_INTERVAL_MS above: re-observing "still not
// terminal" inside this window records nothing and mutates nothing, so an
// overlapping or rapidly re-triggered reconcile pass cannot inflate the
// counter. Set to dispatch-reconcile.yml's own 30-minute scheduled cadence,
// so a genuinely new scheduled pass always clears it.
// Bound on how many distinct, interval-separated "still not terminal"
// observations a bound run gets before its generation is parked
// needs-human. Same bounded-retry posture as
// RECONCILE_MISSING_RUN_MAX_ATTEMPTS (#343/#344).

// Repairs the other half of #645's out-of-band terminalization gap:
// reconcileActive() above already terminalizes the instant GitHub reports
// `run.status === 'completed'` (any conclusion, including cancelled and
// timed-out -- that half needs no repair), but does nothing when GitHub
// keeps reporting a bound run as non-terminal forever. A hung self-hosted
// runner, a runner that lost connectivity without GitHub's own governor
// marking the job failed, or a run GitHub simply never finishes reporting
// on all leave a generation `active` in the ledger with no escalation and
// no park.
//
// Deliberately mirrors trackMissingRun's own grace/interval/bound/park
// shape rather than inventing a second idiom, so the two orphan repairs
// read as one pattern. Every mutation here is recorded in the ledger's
// `anomalies` array before (successful) escalation and is itself
// idempotent, for the same reasons trackMissingRun's own header comment
// gives.
//
// This function must NEVER terminalize the generation itself: declaring a
// run complete that GitHub still reports as running would fabricate an
// outcome, which is exactly what #645's finalizer section forbids. It only
// escalates to a human -- the real terminal state, whenever it actually
// arrives, still lands through reconcileActive()'s own completeRun() call
// above, from GitHub, not from this function's guesswork.
async function trackStuckRun(
  client: GitHubApiClient,
  loaded: LoadedLedger,
  generation: LedgerGeneration,
  run: WorkflowRun,
  now: string,
  maintainer: string,
): Promise<void> {
  const ledger = loaded.ledger;
  if (
    reconcileAnomaliesFor(
      ledger,
      generation.generation,
      'reconcile-stuck-run-parked',
    ).length > 0
  ) {
    return;
  }
  const priorObservations = reconcileAnomaliesFor(
    ledger,
    generation.generation,
    'reconcile-stuck-run',
  );
  const decision = reconcileExecution({
    attempt: {
      dispatchStartedAt:
        generation.attempt?.dispatchStartedAt ?? generation.occurredAt,
      boundAt: generation.attempt?.boundAt,
      runId: generation.attempt?.runId,
    },
    run: { status: run.status, conclusion: run.conclusion },
    now,
    priorObservations,
  });
  if (decision.action === 'wait' || decision.action === 'finalize') return;
  const { ageMs } = decision;
  const attempt = decision.observation;
  const reachedBound = decision.action === 'escalate';
  // Computed up front, once -- see trackMissingRun's own parkFailure for
  // why (shared between the park gate and the 'reconcile-stuck-run-parked'
  // anomaly below rather than two independently-written literals).
  // Exhausting the observation budget doesn't change *why* the run stopped
  // progressing, only that automated waiting has given up on it, so
  // `retryDisposition` moves from `backoff` (the 'reconcile-stuck-run'
  // observation below) to `manual` while `owningSystem`/`reason` stay
  // `runner`/`runner_lost`.
  const parkFailure = reachedBound
    ? classifyFailure({
        phase: 'reconciliation',
        owningSystem: 'runner',
        reason: 'runner_lost',
        retryDisposition: 'manual',
        evidence: `${RECONCILE_STUCK_RUN_MAX_ATTEMPTS} bounded reconcile-stuck-run observations exhausted for generation ${generation.generation}; worker run ${run.id} still reports status "${run.status}"`,
      })
    : undefined;
  // Apply the (idempotent, verify-then-decide) GitHub-side park BEFORE
  // recording it in the ledger: if the mutation throws, the ledger must
  // stay exactly as it was so the next pass retries at the same attempt
  // count, rather than claiming a park that never actually landed. Same
  // ordering trackMissingRun uses, for the same reason, and the same
  // projector needs-human gate (#645 Phase 4) -- parkFailure's `manual`
  // disposition always satisfies it here, so this changes nothing
  // observable.
  if (parkFailure) {
    await projectNeedsHumanPark(client, ledger.task, maintainer, parkFailure);
  }
  addAnomaly(
    ledger,
    'reconcile-stuck-run',
    {
      generation: generation.generation,
      intentId: generation.intentId,
      pipeline: generation.pipeline,
      state: generation.state,
      runId: run.id,
      status: run.status,
      attempt,
      ageMs,
    },
    now,
    // owningSystem: 'runner', not 'controller' -- this reconciler is what
    // NOTICED the stall, but the state that is wrong ("a dispatched run
    // makes progress and eventually reports terminal") is the runner's own
    // execution and reporting, not the controller's ledger bookkeeping. A
    // hung self-hosted runner is squarely the runner's failure even though
    // the controller is the one running this check; `runner_lost` is the
    // vocabulary's own name for exactly "the runner disappeared/stopped
    // reporting". `backoff`, not `manual`: this is still inside the bounded
    // observation window (RECONCILE_STUCK_RUN_MAX_ATTEMPTS) -- the next
    // scheduled reconcile pass, at least RECONCILE_STUCK_RUN_MIN_INTERVAL_MS
    // later, is that retry, and `retryBudget` mirrors the observations this
    // same counter has left before `reconcile-stuck-run-parked` (below)
    // takes over.
    classifyFailure({
      phase: 'reconciliation',
      owningSystem: 'runner',
      reason: 'runner_lost',
      retryDisposition: 'backoff',
      retryBudget: decision.retryBudget,
      evidence: `worker run ${run.id} still reports status "${run.status}" ${ageMs}ms after binding, past the longest legitimate run's own grace period (observation ${attempt}/${RECONCILE_STUCK_RUN_MAX_ATTEMPTS})`,
    }),
  );
  if (parkFailure) {
    addAnomaly(
      ledger,
      // Distinct kind from trackMissingRun's own 'reconcile-parked' so the
      // two orphan classes stay distinguishable in the ledger even once
      // both are parked -- a missing-run park never got a bound run at all,
      // a stuck-run park got one that then stopped making progress, and an
      // operator reading the anomaly list should not have to open `detail`
      // to tell which happened.
      'reconcile-stuck-run-parked',
      {
        generation: generation.generation,
        reason: 'stuck-run-bound-exhausted',
      },
      now,
      // The genuine human handoff: `projectNeedsHumanPark` (above) has
      // just run, and the guard at the top of this function turns every
      // later pass into a no-op, so nothing further happens automatically.
      parkFailure,
    );
  }
  await saveLedger(client, loaded);
}

// Repairs an orphan class outside #305's original scope (#520/#639): a
// `labeled` event's intent that was queue-evicted (#344/#345) before
// verifyBrokerConcurrency ever let broker() reach acceptIntent. This is not
// limited to an empty ledger: a relabel can be lost after earlier generations
// already completed, and the current label remains desired state until its
// real application event has a corresponding ledger source.
// dispatchReconcileScan's candidate discovery already found this issue by
// its current agent:* label, but a `reconcile` payload carries no claim
// about which label or intent that was (#305's design is "re-observe live
// state", not a replayed webhook) -- so re-derive it here from the issue's
// OWN current label, the same signal a live `labeled` event would read.
//
// Deliberately keyed off a label only, not discoverReconcileCandidates's
// other, fleet-assignee candidate lane (#363): that lane's dispatch
// mechanism doesn't go through acceptIntent()/makeIntent() and is out of
// scope for this repair.
//
// No grace period, unlike trackMissingRun: this only fires when the issue
// currently shows one definite, unambiguous agent:* label and the current
// label-application source is absent from the ledger. If a genuine live
// `labeled` event for that very label is still in flight, it shares this
// issue's own concurrency group (queue: max, cancel-in-progress: false)
// and is strictly serialized against this run: it either already ran (so
// generations is no longer empty and this never fires) or is still queued
// behind this run and hasn't touched the ledger yet, so there is nothing
// for this run to race against. A *new* labeled/unlabeled+labeled event
// arriving afterward -- a genuinely new maintainer action, or the rare
// case of a manual webhook redelivery -- carries the exact same
// `timeline:<event-id>` source as this repair and is therefore a duplicate,
// not a second generation. dispatchAccepted's
// no-second-dispatch-while-one-is-active gate is what keeps that from
// running two workers concurrently, exactly as it already does for any
// other legitimate second intent arriving while the first is still active.
//
// Authorization (Codex review, P1): the live `labeled` path in
// normalize.mjs rejects a non-maintainer's label before it ever produces
// an intent (`if (!auth.authorized) throw new Error('Unauthorized label
// dispatch')`). Re-deriving "current label present" from live issue state
// alone -- as an earlier version of this function did -- has no sender to
// check and would silently authorize a repair for a label ANY
// collaborator with issue-write access applied, not just the maintainer.
// Recover the same signal a live event would have used by asking the
// issue's own timeline who most recently applied this exact label, and
// require that actor to be the configured maintainer; an unresolvable or
// non-maintainer authorship leaves the repair undone (fails closed, same
// as the live path) rather than guessing.
//
// #634's one narrow exception is a digest-valid Quick Task whose agent:*
// label was part of the issue-creation request. GitHub emits no separate
// `labeled` timeline event for creation-time labels, so there is no label
// actor to recover. Only when NO matching label event exists, require both
// quickTaskRequest()'s existing marker/digest proof and the issue author's
// login to match the configured maintainer. A real label event always wins:
// its non-maintainer actor cannot fall back to the issue's original author.
//
// Must page through the ENTIRE timeline (listAll), not just its first
// page (Codex review, P1 follow-up): an issue with over 100 timeline
// events could have the label's true most-recent application sitting on
// a later page than a single `per_page=100` GET ever sees, so a
// single-page read can find and trust a stale entry instead -- wrong in
// either direction (authorizing on a superseded maintainer application,
// or rejecting on a superseded non-maintainer one).
async function repairMissingIntentFromLabel(
  client: GitHubApiClient,
  loaded: LoadedLedger,
  now: string,
  runId: number,
  maintainer = '',
): Promise<void> {
  const ledger = loaded.ledger;
  const task = ledger.task;
  const root = repositoryPath(task);
  const issue = await client.requestOk<GitHubIssueDetail>(
    `${root}/issues/${task.issue}`,
  );
  // review:* only ever applies to a pull request (normalize.mjs), and only
  // if the issue carries no agent:* label to repair from first -- the two
  // namespaces coexist, but a stuck agent:* dispatch takes priority since
  // it is the more commonly time-sensitive one (a maintainer waiting on
  // implementation, not a review).
  let pipeline = selectedPipeline(issue);
  let mode = 'implement';
  let labelName = pipeline && `agent:${pipeline}`;
  if (!pipeline && issue.pull_request) {
    const issueLabels = (issue.labels ?? []).map((label) =>
      typeof label === 'string' ? label : label.name,
    );
    pipeline = selectedPipelineFrom(issueLabels, REVIEW_LABELS);
    mode = 'review';
    labelName = pipeline && `review:${pipeline}`;
  }
  if (!pipeline) return;
  const timeline: GitHubTimelineEvent[] = await listAll(
    client,
    `${root}/issues/${task.issue}/timeline`,
  );
  const labelApplications = timeline
    .filter(
      (event) => event.event === 'labeled' && event.label?.name === labelName,
    )
    .sort(
      (left, right) =>
        Date.parse(right.created_at) - Date.parse(left.created_at),
    );
  const mostRecent = labelApplications[0];
  let actor: GitHubUserRef | undefined;
  let authorizationRule = 'reconcile-label-repair';
  let quickTask: ReturnType<typeof quickTaskRequest>;
  let sourceKind: string;
  let sourceId: string;
  let occurredAt: string;
  if (mostRecent) {
    if (!Number.isSafeInteger(mostRecent.id)) return;
    sourceKind = 'labeled';
    sourceId = `timeline:${mostRecent.id}`;
    occurredAt = mostRecent.created_at;
    if (
      ledger.sources.some(
        (source) =>
          source.sourceKind === sourceKind && source.sourceId === sourceId,
      )
    ) {
      return;
    }

    // Compatibility with #520's pre-#639 repair, which used one synthetic
    // source per issue. Do not replay the same historical label application
    // merely because the new implementation now knows its real timeline ID.
    // A later re-application has a later timestamp and is still recovered.
    const legacySource = ledger.sources.find(
      (source) =>
        source.sourceKind === 'reconcile-label-repair' &&
        source.sourceId === `reconcile-label-repair:${issue.id}`,
    );
    const legacyGeneration = ledger.generations.find(
      (generation) => generation.intentId === legacySource?.intentId,
    );
    if (
      legacySource &&
      legacyGeneration?.pipeline === pipeline &&
      legacyGeneration.mode === mode &&
      Date.parse(legacySource.occurredAt) >= Date.parse(occurredAt)
    ) {
      return;
    }

    actor = mostRecent.actor;
    if (!actor || actor.login !== maintainer) return;
    quickTask = quickTaskRequest(issue, task.repository, pipeline);
  } else {
    // Check authorship before parsing the marker. This keeps an untrusted
    // issue author from turning a malformed marker into a reconcile error;
    // ordinary or malformed maintainer-authored issues still fail closed.
    actor = issue.user;
    if (!actor || actor.login !== maintainer) return;
    sourceKind = 'opened';
    sourceId = `issue:${issue.id}`;
    occurredAt = issue.created_at;
    if (
      ledger.sources.some(
        (source) =>
          source.sourceKind === sourceKind && source.sourceId === sourceId,
      )
    ) {
      return;
    }
    quickTask = quickTaskRequest(issue, task.repository, pipeline);
    if (!quickTask) return;
    authorizationRule = 'reconcile-quick-task-create-repair';
  }
  const intent = makeIntent({
    task,
    ...(quickTask && {
      intentId: `quick:${quickTask.requestId}:${quickTask.digest}`,
    }),
    sourceKind,
    sourceId,
    transportRunId: runId,
    occurredAt,
    pipeline,
    mode,
    reply: '',
    runbook: '',
    context: '',
    authorization: {
      authorized: true,
      // mostRecent.actor is proven defined by the guard just above: if it
      // were undefined, `mostRecent.actor?.login` would be `undefined`,
      // which cannot equal `maintainer` there without already returning.
      actor: actor.login,
      configuredMaintainer: maintainer,
      rule: authorizationRule,
    },
  });
  acceptIntent(ledger, intent, now);
  await saveLedger(client, loaded);
}

// Converges a ledger's `control.closed` copy against the issue/PR's live
// open/closed state -- the fix for the success-path bug where GitHub
// closes an anchor (an automerge-linked auto-close via a PR's `Fixes #N`,
// or this repo's own `gh issue close` sweep in agent-automerge.yml) using
// GITHUB_TOKEN. GitHub's documented recursion guard drops any workflow
// trigger an event caused by GITHUB_TOKEN would otherwise fire, so
// agent-router.yml's own live `issues: [closed]`/`pull_request: [closed]`
// triggers never run and applyAnchorControlTransition (broker()'s write for
// a genuine live close event, below) never gets a chance to record it. This
// is the read-and-catch-up half: dispatch-reconcile.yml's bounded closed-
// issue sweep (discoverRecentlyClosedReconcileCandidates, below) puts a
// closed, still agent-labeled OR fleet-assigned issue back in front of a
// reconcile pass, and `issueClosed` -- threaded from main.mjs's own
// normalize() step through ReconcileEvent (normalize.mjs) -- carries the
// one fact only GitHub has: its real current state. Nothing here fetches
// anything itself; a second GET here (on top of normalize()'s own,
// already-unconditional fetch for every workflow_dispatch) would only
// re-earn a fact this pass already has, and would turn every reconcile
// pass -- including the ones a dispatching generation's own grace period
// must stay silent through -- into one that always calls out to GitHub.
//
// broker() (below) calls this directly, ahead of reconcileActive(), for
// every `reconcile` event -- not only indirectly through reconcileLedger's
// own call further down (#715 review: reconcileActive() can throw on an
// anomaly entirely unrelated to whether the anchor is closed, and used to
// run first, so control-state convergence could never outrun it). The
// second call this same pass makes, inside reconcileLedger, is therefore
// always a no-op by the time it runs -- see that function's own header.
//
// `issueClosed === undefined` means the live state genuinely couldn't be
// determined (main.mjs's normalize() didn't -- or couldn't -- fetch the
// issue); falls back to the ledger's own last-recorded copy rather than
// guessing, so a stale-but-unknown-either-way pass changes nothing.
//
// When the two disagree, this writes through applyAnchorControl -- the
// exact function a genuine live `issues.closed`/`pull_request.closed`
// webhook already uses (see applyAnchorControlTransition below) -- so
// revisioning, sourceId dedup, and superseding any `pending`/`accepted`
// generation on close all stay the single mechanism they already were.
// Nothing here ever calls acceptIntent/beginDispatch or otherwise creates a
// generation.
//
// Returns whether the issue IS closed (whether or not this call is what
// converged it) so reconcileLedger can skip every generation-repair branch
// that could create/retry work -- including repairMissingIntentFromLabel,
// the one branch that CAN create a fresh generation. Its one closed-only
// exception terminalizes a durable pre-launch outbox operation after bounded
// run discovery; it can only abandon work, never create it. That boundary is
// what makes "reconciling a closed issue never dispatches a new generation"
// structural, reinforced by dispatchAccepted's own
// `while (!ledger.control.closed)` gate in the same broker() pass.
async function reconcileControlState(
  client: GitHubApiClient,
  loaded: LoadedLedger,
  issueClosed: boolean | undefined,
  now: string,
  runId: number,
): Promise<boolean> {
  const ledger = loaded.ledger;
  if (issueClosed === undefined) return ledger.control.closed;
  if (issueClosed !== ledger.control.closed) {
    applyAnchorControl(
      ledger,
      {
        kind: issueClosed ? 'closed' : 'reopened',
        sourceId: `reconcile-control:${ledger.task.issue}:${issueClosed ? 'closed' : 'reopened'}:${now}`,
        occurredAt: now,
        transportRunId: runId,
        authorization: { observed: true, actor: 'dispatch-broker' },
        // A reconcile pass only carries the issue's own open/closed state
        // (see ReconcileEvent/`issueClosed` in normalize.mjs), not the
        // richer merge signal a live `issues`/`pull_request` webhook
        // payload carries -- unlike control.closed, nothing reads
        // control.merged today (grep finds only its two writers), so
        // recording it as unknown-here rather than threading a second
        // field through purely to populate descriptive metadata is a
        // deliberate simplification, not an oversight.
        merged: false,
      },
      now,
    );
    await saveLedger(client, loaded);
  }
  return issueClosed;
}

// The `reconcile` normalized kind's own repair (#305), invoked from
// broker() after reconcileActive() has already had its normal chance to
// bind/complete the current active generation. Everything reconcileActive()
// already covers (bind an unambiguous run, complete a terminal bound run,
// anomaly+fail-closed a genuine duplicate-run collision) is intentionally
// NOT duplicated here -- this only closes reconcileActive()'s one remaining
// gap (a persistently runless dispatch) and one defensive invariant check.
//
// `issueClosed` (from ReconcileEvent, normalize.mjs) is checked first, via
// reconcileControlState, before any of the generation-repair logic below --
// see that function's own header for why a closed anchor can only enter the
// narrow pending-launch abandonment path rather than falling through.
// broker() (#715) already made
// this exact reconcileControlState call itself, ahead of reconcileActive(),
// before ever reaching this function -- so by the time reconcileLedger runs
// at all, this call is normally a no-op re-observation of an
// already-converged ledger; it stays here (rather than being removed) so
// reconcileLedger keeps converging control state correctly on its own for
// every other caller, direct test included. A reopened anchor (`issueClosed
// === false` while the ledger still says closed) converges the same way but
// does NOT return early: an issue reopened after a stale close is ordinary
// open-issue territory, and the discovery lane that would have found it in
// the first place is the existing open/fleet-assignee one
// (discoverReconcileCandidates) -- a reopened anchor still carries
// whichever agent:*/assignee signal got it discovered, so no dedicated
// "reopened sweep" is needed alongside the closed one.
async function reconcileLedger(
  client: GitHubApiClient,
  loaded: LoadedLedger,
  now: string = new Date().toISOString(),
  runId: number,
  issueClosed?: boolean,
  maintainer = '',
): Promise<void> {
  const ledger = loaded.ledger;
  const anchorClosed = await reconcileControlState(
    client,
    loaded,
    issueClosed,
    now,
    runId,
  );
  if (anchorClosed) {
    // Closed anchors normally skip every generation repair below. The sole
    // exception is a durable pre-launch outbox operation: it must age
    // through the same bounded run-discovery window as an open attempt, then
    // be terminalized as abandoned rather than retried or parked. Restrict
    // this path to the exact known operation so an unrelated closed active
    // generation retains the historical no-op behavior.
    const active = activeGeneration(ledger);
    const attemptId = active?.attempt?.attemptId;
    if (
      loaded.authority &&
      active &&
      attemptId &&
      ['dispatching', 'dispatch-unknown'].includes(active.state) &&
      !active.attempt?.runId
    ) {
      const launchRead = await readLaunchOperationForReconciliation(
        loaded,
        attemptId,
      );
      if (!launchRead.ok) return;
      const operation = launchRead.operation;
      if (
        operation?.operationId === attemptId &&
        operation.attemptId === attemptId &&
        (operation.status === 'pending' ||
          (operation.resolution?.status === 'rejected' &&
            operation.resolution.reason === CLOSED_ANCHOR_LAUNCH_REJECTION))
      ) {
        await trackMissingRun(client, loaded, active, now, maintainer);
      }
    }
    return;
  }
  // A lost relabel that arrived during an active attempt can be recovered
  // after that attempt terminalizes; avoid adding live issue/timeline reads
  // to the hot active-run repair path. Empty and terminal-only ledgers are
  // the states where a missing current-label source would otherwise remain
  // invisible forever (#639).
  if (ledger.generations.length === 0 || !activeGeneration(ledger)) {
    await repairMissingIntentFromLabel(client, loaded, now, runId, maintainer);
  }
  if (ledger.generations.length === 0) return;
  const active = activeGeneration(ledger);
  const pending = ledger.generations.find(
    (candidate) => candidate.state === 'pending',
  );
  if (
    pending &&
    !active &&
    reconcileAnomaliesFor(
      ledger,
      pending.generation,
      'reconcile-invariant-violation',
    ).length === 0
  ) {
    // Should be unreachable through broker.mjs's own transitions (a
    // `pending` generation only ever exists alongside a contemporaneous
    // active one, and every path that resolves the active generation also
    // promotes pending -- see completeRun/markDispatchRejected). Surfacing
    // it loudly rather than guessing/promoting is #305's "never silently
    // discard evidence" requirement applied to ledger data that itself
    // looks corrupted. "Should be unreachable through broker.mjs's own
    // transitions" is this vocabulary's own definition of `internal_error`
    // -- a defensive check catching corrupted-looking ledger state, not a
    // failure any known external cause (a lost signal, a lost launch
    // response, a provider outage, ...) explains. The ledger this invariant
    // is about is the controller's own state, so it -- not whichever system
    // produced the generations in question -- is the explicit owner
    // reconciliation-phase failures require. `manual`: the guard above
    // (reconcileAnomaliesFor(...).length === 0) makes every later pass a
    // no-op once this fires, identical to reconcile-parked's own idempotent
    // stop -- nothing about this resolves itself, a human has to look at
    // the ledger and decide what actually happened.
    const parkFailure = classifyFailure({
      phase: 'reconciliation',
      owningSystem: 'controller',
      reason: 'internal_error',
      retryDisposition: 'manual',
    });
    // Mutation-before-ledger-write (same ordering as trackMissingRun above)
    // so a failed park never leaves the ledger falsely claiming one landed;
    // the anomaly check above makes a repeat pass, once parked, a true
    // no-op. Routed through the projector's own needsMaintainer gate (#645
    // Phase 4) rather than calling ensureNeedsHumanParked directly --
    // parkFailure's `manual` disposition always satisfies that gate here,
    // so this changes nothing observable.
    await projectNeedsHumanPark(client, ledger.task, maintainer, parkFailure);
    addAnomaly(
      ledger,
      'reconcile-invariant-violation',
      {
        detail: 'pending generation with no contemporaneous active generation',
        generation: pending.generation,
      },
      now,
      parkFailure,
    );
    await saveLedger(client, loaded);
    return;
  }
  if (!active || !['dispatching', 'dispatch-unknown'].includes(active.state)) {
    return;
  }
  if (active.attempt?.runId) return;
  await trackMissingRun(client, loaded, active, now, maintainer);
}

// Fires one workflow_dispatch `kind: reconcile` call at agent-router.yml per
// already-discovered candidate issue (#305's scan side). Each call reuses
// agent-router.yml's own normalize -> broker jobs end to end: the same
// per-issue `agent-lcars-dispatch-v1-<repositoryId>-<issue>` concurrency
// group, and #349's already-hardened indirect concurrency corroboration for
// workflow_dispatch-triggered runs. This function never touches a ledger
// comment itself, so it needs no concurrency verification of its own --
// only dispatch-reconcile.yml's single scan-wide concurrency group (to
// avoid two overlapping scans firing duplicate dispatches) applies here.
// Bounds how many workflow_dispatch POSTs dispatchReconcileScan fires at
// once. Every candidate's dispatch is independent -- no ordering dependency
// between them -- but the fleet-assignee discovery lane (#363 review) can
// legitimately return a large historical backlog, and an unbounded burst of
// simultaneous POSTs risks tripping GitHub's secondary rate limits (a PR
// #374 review finding): the resulting rejections would just become
// per-candidate failures, silently skipping otherwise-healthy candidates
// for this pass. A small worker pool (mapWithConcurrency) still attempts
// every candidate and keeps per-candidate failure isolation, just bounded.
interface ReconcileScanResults {
  dispatched: number;
  failed: { issue: number; message: string }[];
}

async function dispatchReconcileScan(
  client: GitHubApiClient,
  repository: string,
  issueNumbers: number[],
): Promise<ReconcileScanResults> {
  return dispatchReconcileScanShared(
    createReconcileTransport(client),
    repository,
    issueNumbers,
  );
}

function isDefiniteDispatchRejection(error: unknown): error is GitHubApiError {
  return (
    error instanceof GitHubApiError &&
    Number.isInteger(error.status) &&
    (error.status as number) >= 400 &&
    (error.status as number) < 500 &&
    ![408, 409, 429].includes(error.status as number)
  );
}

async function resolveLaunchOutcomeBestEffort(
  loaded: LoadedLedger,
  generation: LedgerGeneration,
  resolution: Parameters<StoragePort['resolveLaunchOutcome']>[1],
): Promise<void> {
  if (!loaded.authority) return;
  const attemptId =
    generation.attempt?.attemptId ?? formatAttemptId(generation);
  try {
    await loaded.authority.port.resolveLaunchOutcome(attemptId, resolution);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `::warning::Primary dispatch state was persisted, but launch-outbox ` +
        `resolution for ${attemptId} will need reconciliation: ${message}`,
    );
  }
}

async function resolvePendingLaunchAsLaunchedBestEffort(
  loaded: LoadedLedger,
  generation: LedgerGeneration,
  binding: { runId: number; runUrl: string; htmlUrl: string },
): Promise<void> {
  if (!loaded.authority) return;
  const attemptId =
    generation.attempt?.attemptId ?? formatAttemptId(generation);
  try {
    const operation =
      await loaded.authority.port.readLaunchOperation(attemptId);
    if (operation?.status !== 'pending') return;
    await loaded.authority.port.resolveLaunchOutcome(attemptId, {
      status: 'launched',
      binding,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `::warning::Reconciliation confirmed workflow run ${binding.runId}, ` +
        `but launch-outbox resolution for ${attemptId} will need another ` +
        `pass: ${message}`,
    );
  }
}

function issueHasNeedsHumanLabel(issue: GitHubIssueDetail): boolean {
  return (issue.labels ?? []).some((label) =>
    typeof label === 'string'
      ? label === 'status:needs-human'
      : label.name === 'status:needs-human',
  );
}

async function anchorNeedsHuman(
  client: GitHubApiClient,
  task: LedgerTaskRef,
): Promise<boolean> {
  const issue = await client.requestOk<GitHubIssueDetail>(
    `${repositoryPath(task)}/issues/${task.issue}`,
  );
  return issueHasNeedsHumanLabel(issue);
}

async function holdForLaneReadiness(
  client: GitHubApiClient,
  loaded: LoadedLedger,
  generation: LedgerGeneration,
): Promise<boolean> {
  const blockers = await readLaneReadiness(
    client,
    loaded.ledger.task,
    generation.pipeline,
  );
  if (blockers.length === 0) return false;
  const display =
    generation.pipeline[0].toUpperCase() + generation.pipeline.slice(1);
  await projectComment(
    client,
    loaded.ledger.task,
    'lane-readiness',
    generation.pipeline,
    (marker) => `${marker}

### ${display} dispatch paused for lane readiness

The broker held generation ${generation.generation} **before worker allocation** because the following durable health signal${blockers.length === 1 ? ' is' : 's are'} open:

${blockers.map((blocker) => `- [#${blocker.issue}: ${blocker.title}](${blocker.url})`).join('\n')}

This is an automatic infrastructure hold, not a human-owned task park. Repair the linked health incident and close it. Scheduled reconcile will retry the readiness check and resume this accepted generation; do not create another dispatch generation. This notice is live only while a linked health issue remains open.`,
  );
  console.log(
    `::notice::Holding accepted ${generation.pipeline} generation ` +
      `${generation.generation} for issue #${loaded.ledger.task.issue} ` +
      `before worker allocation: readiness blocker${blockers.length === 1 ? '' : 's'} ` +
      blockers.map((blocker) => `#${blocker.issue}`).join(', '),
  );
  return true;
}

async function dispatchAccepted(
  client: GitHubApiClient,
  loaded: LoadedLedger,
): Promise<void> {
  while (!loaded.ledger.control.closed) {
    const generation = loaded.ledger.generations.find(
      (candidate) => candidate.state === 'accepted',
    );
    if (!generation || activeGeneration(loaded.ledger)) return;
    // #720: accepted is ledger readiness, not unconditional permission to
    // spend another agent run. status:needs-human is the human-facing stop
    // signal; read it live at the last responsible moment so a generation
    // promoted while its predecessor completed remains held until the label
    // is removed.
    if (await anchorNeedsHuman(client, loaded.ledger.task)) {
      console.log(
        `::notice::Holding accepted generation ${generation.generation} for ` +
          `issue #${loaded.ledger.task.issue}: status:needs-human is present. ` +
          'Remove the label to resume through the ordinary serialized broker path.',
      );
      return;
    }
    if (await holdForLaneReadiness(client, loaded, generation)) return;
    const beforeScheduling = structuredClone(loaded.ledger);
    const scheduled = await runPhase(
      { client, loaded },
      'scheduling',
      async () => {
        beginDispatch(
          loaded.ledger,
          generation.generation,
          crypto.randomBytes(24).toString('base64url'),
        );
        if (loaded.authority) {
          const attemptId =
            generation.attempt?.attemptId ?? formatAttemptId(generation);
          try {
            await loaded.authority.port.recordLaunchIntent({
              operationId: attemptId,
              task: loaded.ledger.task,
              attemptId,
            });
          } catch (error) {
            // No scheduling state or workflow dispatch has been persisted.
            // Restore the in-memory aggregate; a response-lost outbox create
            // is idempotent on the same stable attemptId during the retry.
            loaded.ledger = beforeScheduling;
            const message =
              error instanceof Error ? error.message : String(error);
            console.log(
              `::warning::Deferring worker dispatch after launch-outbox ` +
                `recording failed: ${message}`,
            );
            return false;
          }
        }
        // The outbox intent is durable before `dispatching` becomes durable.
        // A crash on either side of this checkpoint is retryable: before it,
        // persisted state is still accepted; after it, reconciliation has the
        // pending operation proving that no launch outcome was lost.
        await saveLedger(client, loaded);
        return true;
      },
    );
    if (!scheduled) return;
    let binding: {
      runId: number;
      runUrl: string;
      htmlUrl: string;
      workflow: string;
    };
    try {
      binding = await dispatchWorker(client, generation, loaded.ledger.task);
    } catch (error) {
      if (isDefiniteDispatchRejection(error)) {
        // Definite: the dispatch POST itself was rejected, so this
        // generation is not ambiguously in flight -- unlike the
        // markDispatchUnknown branch below, this is a genuine launch
        // failure, worth classifying and recording before it escalates.
        await runPhase({ client, loaded }, 'launch', async () => {
          markDispatchRejected(
            loaded.ledger,
            generation.generation,
            `HTTP ${error.status}`,
          );
          await saveLedger(client, loaded);
          await resolveLaunchOutcomeBestEffort(loaded, generation, {
            status: 'rejected',
            reason: `HTTP ${error.status}`,
          });
          throw error;
        });
      }
      // Ambiguous (e.g. a timeout after the POST may have already landed
      // server-side): deliberately NOT run through runPhase. This is not
      // yet a confirmed failure -- the reconciler resolves it later -- so
      // recording it here would misrepresent an unresolved outcome as an
      // attributed one.
      markDispatchUnknown(
        loaded.ledger,
        generation.generation,
        // Assumed Error-shaped, exactly as the untyped original assumed.
        (error as Error).message.slice(0, 300),
      );
      await saveLedger(client, loaded);
      await resolveLaunchOutcomeBestEffort(loaded, generation, {
        status: 'unknown',
        reason: (error as Error).message.slice(0, 300),
      });
      return;
    }

    // A validated 200 response makes the launch outcome known. Persist its
    // exact run binding before resolving the auxiliary outbox record, so a
    // transient outbox failure can never be reclassified as an ambiguous
    // workflow dispatch or park a successfully launched worker.
    bindRun(loaded.ledger, generation.generation, binding);
    await saveLedger(client, loaded);
    await resolveLaunchOutcomeBestEffort(loaded, generation, {
      status: 'launched',
      binding,
    });
    return;
  }
}

export class CompletionBindingError extends Error {}

function completionLedgerMatches(
  generation: LedgerGeneration | undefined,
  normalized: CompletionEvent,
): boolean | undefined {
  return (
    generation &&
    generation.intentId === normalized.intentId &&
    generation.attempt?.token === normalized.token &&
    generation.attempt?.runId === normalized.workerRunId &&
    normalized.workflow === workerWorkflow(generation.pipeline)
  );
}

/**
 * Reject a completion body that is not bound to the selected task's exact
 * authoritative generation. This check runs while the task lease is held,
 * before projection or controller mutation, so a valid worker identity with
 * stale or caller-selected body fields cannot park an unrelated anchor.
 */
export function assertCompletionLedgerBinding(
  ledger: DispatchLedger,
  normalized: CompletionEvent,
): LedgerGeneration {
  const generation = ledger.generations.find(
    (candidate) => candidate.generation === normalized.generation,
  );
  if (!generation || !completionLedgerMatches(generation, normalized)) {
    throw new CompletionBindingError(
      'Completion callback does not match the bound worker run',
    );
  }
  return generation;
}

/**
 * Authenticate a completion against existing compatibility state without
 * creating state, projecting a comment, or invoking fail-closed parking.
 * The Firestore authority path acquires its shared lease in loadBrokerLedger
 * before validating, so a fast callback cannot race the controller's bindRun
 * write. The loaded copy is checked again below before mutation.
 */
export async function assertCompletionBindingBeforeInitialization(
  _client: GitHubApiClient,
  task: LedgerTaskRef,
  normalized: CompletionEvent,
  storagePortFactory: () => StoragePort,
): Promise<void> {
  const ledger = (await storagePortFactory().readTask(task))?.controllerState;
  if (!ledger) {
    throw new CompletionBindingError(
      'Completion callback does not match the bound worker run',
    );
  }
  assertCompletionLedgerBinding(ledger, normalized);
}

function completionMatches(
  generation: LedgerGeneration | undefined,
  normalized: CompletionEvent,
  run: WorkflowRun,
): boolean | undefined {
  return (
    completionLedgerMatches(generation, normalized) &&
    run.id === normalized.workerRunId
  );
}

async function handleCompletion(
  client: GitHubApiClient,
  loaded: LoadedLedger,
  normalized: CompletionEvent,
  polling: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    pollUntilTerminal?: boolean;
    maintainer?: string;
  } = {},
): Promise<void> {
  const now = polling.now ?? Date.now;
  const sleep =
    polling.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const generation = loaded.ledger.generations.find(
    (candidate) => candidate.generation === normalized.generation,
  );
  let run: WorkflowRun = await getWorkflowRun(
    client,
    normalized.task,
    normalized.workerRunId,
  );
  // A missing generation crashes below exactly as it always did (originally
  // via an undefined destructure inside displayTitleMatchesAttempt); these
  // assertions add no new runtime check, they only name the same
  // already-assumed invariant for the compiler.
  const expectedWorkflow = workerWorkflow(
    generation?.pipeline as DispatchPipeline,
  );
  assertWorkerRun(
    run,
    normalized.task,
    generation as LedgerGeneration,
    expectedWorkflow,
  );
  // assertWorkerRun above did not throw, and per the comment on `generation`
  // above, that is only possible if `generation` was actually defined --
  // displayTitleMatchesAttempt destructures it and would have thrown first
  // otherwise. This makes that already-proven invariant explicit for the
  // compiler instead of asserting past it at every site below.
  if (!generation) {
    throw new Error(`Generation ${normalized.generation} not found`);
  }
  if (
    normalized.workflow !== expectedWorkflow ||
    !completionMatches(generation, normalized, run)
  ) {
    throw new Error('Completion callback does not match the bound worker run');
  }
  const evidence = recordControlEvidence(loaded.ledger, {
    sourceKind: 'completion',
    sourceId: normalized.sourceId,
    transportRunId: normalized.transportRunId,
    occurredAt: new Date().toISOString(),
    runId: normalized.workerRunId,
    authorization: { observed: true, workflow: expectedWorkflow },
  });
  const priorOutcome = generation.attempt?.outcome;
  const priorOutcomeReference = generation.attempt?.outcomeReference;
  if (normalized.outcome) {
    recordOutcome(
      loaded.ledger,
      generation.generation,
      normalized.outcome,
      normalized.outcomeReference,
    );
  }
  // A lane-health incident is a projection of a trusted worker signal, not
  // attempt authority. Create it before persisting this callback's evidence:
  // if the issue mutation fails, redelivery sees no recorded source and can
  // retry; after both succeed, a later stale redelivery cannot reopen an
  // incident an operator already closed after remediation.
  if (normalized.readinessFailure && evidence.outcome === 'recorded') {
    await ensureLaneReadinessAlert(
      client,
      normalized.task,
      generation.pipeline,
      normalized.readinessFailure,
      run.html_url,
      polling.maintainer ?? '',
    );
  }
  if (generation.state === 'completed') {
    if (
      evidence.outcome === 'recorded' ||
      (normalized.outcome && priorOutcome !== normalized.outcome) ||
      (normalized.outcomeReference &&
        JSON.stringify(priorOutcomeReference) !==
          JSON.stringify(normalized.outcomeReference))
    ) {
      await saveLedger(client, loaded);
    }
    return;
  }
  if (generation.state === 'active') {
    observeCompletion(loaded.ledger, generation.generation, run.id);
  }
  await saveLedger(client, loaded);

  // A hosted callback is made by the worker run whose terminal state this
  // loop observes. Holding that HTTP request open while polling the caller
  // creates a circular wait: the run cannot finish until the callback
  // returns. Persist the authenticated completion observation and let the
  // hosted reconciler finalize it once GitHub reports the run terminal.
  if (polling.pollUntilTerminal === false) return;

  const deadline = now() + 120_000;
  let delay = 2_000;
  while (run.status !== 'completed' && now() < deadline) {
    await sleep(delay);
    delay = Math.min(delay * 2, 15_000);
    // Completion polling can run for the full two-minute lease interval and
    // its final sleep may cross the deadline. Renew before every remote read
    // so another Action or hosted delivery cannot take the lease while this
    // completion handler still owns and is about to persist the aggregate.
    if (loaded.authority) {
      await persistAuthority(
        loaded.authority,
        loaded.ledger,
        new Date(now()).toISOString(),
      );
    }
    try {
      run = await getWorkflowRun(
        client,
        normalized.task,
        normalized.workerRunId,
      );
      assertWorkerRun(
        run,
        normalized.task,
        generation as LedgerGeneration,
        expectedWorkflow,
      );
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        (error.status === 404 || (error.status as number) >= 500)
      ) {
        continue;
      }
      throw error;
    }
  }
  if (run.status !== 'completed') {
    if (generation.state === 'completion-observed') {
      awaitTerminal(loaded.ledger, generation.generation);
      await saveLedger(client, loaded);
    }
    return;
  }
  completeRun(loaded.ledger, generation.generation, {
    runId: run.id,
    status: run.status,
    conclusion: run.conclusion,
    completedAt: run.updated_at,
  });
  await saveLedger(client, loaded);
}

function resolveTask(normalized: NormalizedEvent): LedgerTaskRef {
  // Every normalized kind carries a canonical TaskRef, but intents nest
  // theirs under `.intent.task` (see normalize.mjs's makeIntent) while
  // completion/anchor-control/control-evidence carry `.task` at the top
  // level. Resolve per kind so broker() reads one consistent value.
  return normalized.kind === 'intent'
    ? normalized.intent.task
    : // Ignored events are filtered out by broker() before this is ever
      // called; the cast documents that, matching the untyped original's own
      // unguarded `.task` read for every other kind.
      (normalized as { task: LedgerTaskRef }).task;
}

// Only a `retryable: true` mismatch is eligible: every other failure mode
// (config mismatch, malformed response, more than one match) is a real
// anomaly that retrying or supersession-checking cannot explain away, so
// it must keep failing red immediately (issue #344's "genuinely
// unexplained mismatch" requirement). Even for the eligible case, absence
// of a corroborating superseding run must NOT be treated as proof of
// eviction -- it just means this run's mismatch is still unexplained, so
// the caller keeps failing red.
//
// Corroborated eviction is only safe to drop for `control-evidence` and
// `reconcile`: both are non-authoritative pings the superseding run's own,
// separately-sourced evidence does not depend on -- losing either only
// shrinks the audit trail (`control-evidence`) or simply waits for the next
// scheduled pass (`reconcile`, #305: dispatch-reconcile.yml re-fires the
// identical idempotent `kind: reconcile` ping for this issue on its next
// 30-minute cadence regardless, so an evicted one is never "permanently
// lost" the way an evicted intent would be). `intent`, `completion`, and
// `anchor-control` are not interchangeable with whatever the superseding
// run happens to carry: the superseding run corresponds to a *different*
// triggering event (its own distinct sourceId), so it offers no guarantee
// of carrying this run's payload forward. An evicted `intent` is an
// authorized dispatch request that would be silently lost forever; an
// evicted `completion` would leave its generation active forever; an
// evicted `anchor-control` would leave the issue's open/closed state
// unresolved. Those must still fail red even when eviction is
// corroborated (#344 follow-up), with an error naming what was lost so a
// maintainer knows to manually re-dispatch it.
const EVICTION_TOLERANT_KINDS = new Set(['control-evidence', 'reconcile']);

async function wasSupersededEviction(
  client: GitHubApiClient,
  task: LedgerTaskRef,
  runId: number,
  group: string,
  kind: string,
  error: unknown,
): Promise<boolean> {
  // Genuinely untrusted here: whatever verifyBrokerConcurrency's caller
  // threw, of any shape. Every field is checked before use, same as the
  // untyped original's own optional-chained reads.
  const candidate = error as
    { name?: string; retryable?: boolean } | null | undefined;
  if (
    candidate?.name !== 'BrokerConcurrencyMismatchError' ||
    !candidate.retryable
  ) {
    return false;
  }
  const superseding: WorkflowRun | undefined = await findSupersedingRouterRun(
    client,
    task,
    runId,
  );
  if (!superseding) return false;
  if (!EVICTION_TOLERANT_KINDS.has(kind)) {
    throw new Error(
      `Broker run ${runId} (group ${group}, issue #${task.issue}) was ` +
        `evicted from its concurrency queue by newer run ${superseding.id}, ` +
        `but this event carries a '${kind}' payload. Only observational ` +
        'control-evidence/reconcile pings may be dropped on a corroborated ' +
        `eviction (#344, #305); a superseding run does not carry this ` +
        `event's '${kind}' payload forward, since it corresponds to a ` +
        "different triggering event. This event's payload is presumed " +
        'permanently lost -- a maintainer must manually re-dispatch it to ' +
        'recover.',
      { cause: error },
    );
  }
  console.log(
    `::notice::Broker run ${runId} (group ${group}, issue #${task.issue}) ` +
      `was evicted from its concurrency queue by newer run ${superseding.id}, ` +
      'which now reports the expected group. Treating this run as ' +
      `superseded rather than failing (#344/#305): this run's own '${kind}' ` +
      'payload for its triggering event is not recorded in the ledger -- ' +
      'the superseding run already carries the issue forward correctly.',
  );
  return true;
}

// Only these two acceptIntent() outcomes leave the resulting generation in
// a non-superseded state ('accepted' for 'dispatch', 'pending' for
// 'pending') -- every other outcome ('duplicate', 'semantic-duplicate',
// 'stale', 'stale-control-state', 'closed') means either nothing new was
// recorded or the ledger has already judged this intent not to be the
// current desired state. A self-heal must never act on the latter: an old
// `labeled` webhook rerun/redelivered after the maintainer has since
// switched back to the label this payload calls "stale" would otherwise
// delete the maintainer's actual current selection (PR #355 review).
const FRESH_INTENT_OUTCOMES = new Set(['dispatch', 'pending']);

// Self-heals the transient manual-relabel dual-label window (#304 audit
// item 4): normalize.mjs marks an intent's `staleAgentLabels` when a
// `labeled` event's own label disambiguates against exactly one other
// label still on the issue in that same namespace (agent:* or, on a pull
// request, review:* -- the two families never contend with each other).
// Removing the stale label(s) here -- inside the serialized broker write
// path, the only place control-plane writes are allowed -- restores the
// "exactly one label in that namespace" contract before the intent
// dispatches.
//
// Belt-and-braces beyond the FRESH_INTENT_OUTCOMES gate at the call site:
// the payload's dual-label snapshot can still be stale by the time this
// runs (e.g. a slow/retried run), so re-read the issue's live labels and
// only remove a stale label that is STILL present TOGETHER WITH the
// event's own (newer) label. If live state no longer matches -- most
// notably, the maintainer switched back and only the "stale" label remains
// -- skip that label with a `::notice::` and record no evidence for it.
//
// Idempotent by construction: `removeIssueLabel` tolerates 404 (label
// already gone), and `recordControlEvidence`'s own sourceKind/sourceId
// dedup (keyed off the triggering intent's sourceId, so a redelivery of the
// same underlying event reuses the same evidence sourceId) means a
// redelivered event only re-saves the ledger when it actually added new
// evidence, matching the pattern `handleCompletion` already uses below.
async function healStaleAgentLabels(
  client: GitHubApiClient,
  loaded: LoadedLedger,
  intent: Intent,
): Promise<void> {
  const staleLabels = intent.staleAgentLabels;
  if (!staleLabels?.length) return;
  const task = loaded.ledger.task;
  // staleAgentLabels is only ever set by normalize.mjs's labeled-event
  // self-heal, whose namespace (agent:* vs review:* -- never mixed, see
  // normalize.mjs) is exactly what produced this intent's own `mode`.
  const eventLabel = `${intent.mode === 'review' ? 'review' : 'agent'}:${intent.pipeline}`;
  const issue = await client.requestOk<GitHubIssueDetail>(
    `${repositoryPath(task)}/issues/${task.issue}`,
  );
  const currentLabels = new Set(
    (issue.labels ?? []).map((label) =>
      typeof label === 'string' ? label : label.name,
    ),
  );
  const removable: string[] = [];
  const skipped: string[] = [];
  for (const label of staleLabels) {
    if (currentLabels.has(label) && currentLabels.has(eventLabel)) {
      removable.push(label);
    } else {
      skipped.push(label);
    }
  }
  if (skipped.length > 0) {
    console.log(
      `::notice::Skipping stale-label self-heal for ${skipped.join(', ')} ` +
        `on issue #${task.issue}: live labels no longer match the ` +
        `dual-label snapshot this intent was normalized from (current: ` +
        `${[...currentLabels].join(', ') || 'none'}).`,
    );
  }
  if (removable.length === 0) return;
  for (const label of removable) {
    await removeIssueLabel(client, task, label);
  }
  const evidence = recordControlEvidence(loaded.ledger, {
    sourceKind: 'label-self-heal',
    sourceId: `label-self-heal:${intent.sourceId}`,
    transportRunId: intent.transportRunId,
    occurredAt: new Date().toISOString(),
    labels: removable,
    authorization: { observed: true, actor: 'dispatch-broker' },
  });
  if (evidence.outcome === 'recorded') await saveLedger(client, loaded);
}

async function loadBrokerLedger(
  client: GitHubApiClient,
  task: LedgerTaskRef,
  normalized: NormalizedEvent,
  isPullRequest: boolean,
  leaseOwner = '',
  storagePortFactory: () => StoragePort = createStoragePort,
  authorityEpoch = '',
  projectionIdentities?: readonly LedgerProjectionIdentity[],
  authorityBusyWaitMs = 130_000,
): Promise<LoadedLedger | undefined> {
  // GitHub fires this workflow for every PR close/reopen in the repository.
  // Ledger presence is the durable signal that a PR is actually a broker
  // anchor; do not create ledger comments on ordinary PRs just because their
  // lifecycle changed. Issue events keep the existing create-if-missing
  // behavior, and every other PR broker event still creates its required
  // ledger normally.
  const untrackedPullRequestControl =
    isPullRequest && normalized.kind === 'anchor-control';
  {
    const port = storagePortFactory();
    let authority;
    try {
      authority = await acquireAuthority(
        port,
        task,
        leaseOwner,
        createLedger(task),
        {
          // Missing state needs a GitHub projection check below before a new
          // empty aggregate can be created safely.
          createIfMissing: false,
          busyWaitMs: authorityBusyWaitMs,
        },
      );
    } catch (error) {
      // Neither an absent task nor a compatibility-only record can
      // authenticate a hosted completion. Convert both before the generic
      // initialization/fail-closed paths so caller-selected input cannot
      // create projection or parking side effects.
      if (
        normalized.kind === 'completion' &&
        (error instanceof AuthorityStateNotFoundError ||
          error instanceof AuthorityStateMissingError)
      ) {
        throw new CompletionBindingError(
          'Completion callback does not match the bound worker run',
        );
      }
      if (error instanceof AuthorityStateNotFoundError) {
        const initializationEvidence =
          await classifyAuthorityTaskInitialization(
            client,
            task,
            authorityEpoch,
            projectionIdentities,
          );
        // Every PR close/reopen is routed here. With no exact state and no
        // workflow-owned compatibility projection, the PR was never a
        // dispatch anchor, so it is an intentional no-op regardless of its
        // age. A projection is durable evidence that the PR *was* tracked;
        // missing exact state for that case still fails closed as a missed
        // backfill instead of silently discarding the control event.
        if (
          untrackedPullRequestControl &&
          initializationEvidence !== 'compatibility-projection'
        ) {
          return undefined;
        }
        if (initializationEvidence !== 'post-cutover') {
          throw new AuthorityStateMissingError(task);
        }
        authority = await acquireAuthority(
          port,
          task,
          leaseOwner,
          createLedger(task),
          { busyWaitMs: authorityBusyWaitMs },
        );
      } else {
        throw error;
      }
    }
    if (normalized.kind === 'completion') {
      try {
        // Acquire the shared lease before deciding that a callback is
        // unbound. A just-dispatched worker can reach this endpoint while
        // the dispatching controller still owns the lease and is about to
        // persist bindRun; acquireAuthority waits behind that owner. Keep
        // this check ahead of loadLedgerProjection so a genuinely invalid
        // callback cannot create or repair GitHub projection state.
        assertCompletionLedgerBinding(authority.ledger, normalized);
      } catch (error) {
        try {
          await releaseAuthority(authority.session, authority.ledger);
        } catch (releaseError) {
          const message =
            releaseError instanceof Error
              ? releaseError.message
              : String(releaseError);
          console.log(
            `::warning::Failed to release rejected completion lease; ` +
              `it will expire automatically: ${message}`,
          );
        }
        throw error;
      }
    }
    try {
      const projected: LoadedLedger = await loadLedgerProjection(
        client,
        task,
        authority.ledger,
        projectionIdentities,
      );
      projected.authority = authority.session;
      projected.projectionAvailable = true;
      return projected;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        `::warning::Loaded authoritative Firestore state for ` +
          `${task.repository}#${task.issue}, but its GitHub ledger ` +
          `projection is unavailable this pass: ${message}`,
      );
      return {
        ledger: authority.ledger,
        comment: { id: 0, body: '', created_at: '' },
        created: false,
        authority: authority.session,
        projectionAvailable: false,
      };
    }
  }
}

async function applyAnchorControlTransition(
  client: GitHubApiClient,
  loaded: LoadedLedger,
  control: AnchorControl,
): Promise<void> {
  applyAnchorControl(loaded.ledger, control);
  await saveLedger(client, loaded);
}

export interface BrokerPassOptions {
  normalized: NormalizedEvent;
  githubToken: string;
  authorityEpoch?: string;
  storagePortFactory: () => StoragePort;
  isPullRequest: boolean;
  transportRunId: number;
  authorityOwner: string;
  maintainer?: string;
  /** Action-only concurrency evidence. Hosted callers omit this because the
   * Firestore authority lease is their serialization primitive. */
  actionConcurrency?: { group: string; eventName?: string };
  /** Identities allowed to own the compatibility projection. Firestore,
   * never the comment, remains controller authority. */
  projectionIdentities?: readonly LedgerProjectionIdentity[];
  /** How long this transport may wait for another authority lease. */
  authorityBusyWaitMs?: number;
  /** Hosted worker callbacks must return after recording the observation:
   * the calling workflow cannot become terminal while its HTTP request is
   * still waiting. Action callbacks retain the bounded terminal poll. */
  pollCompletionUntilTerminal?: boolean;
}

/**
 * Execute one already-normalized controller delivery.
 *
 * The GitHub Action and the hosted webhook endpoint deliberately share this
 * exact transition path. Transport-specific concerns stay in their wrappers:
 * the Action verifies its lossy concurrency-group serialization, while the
 * hosted endpoint relies on the durable Firestore lease acquired below.
 */
export async function processNormalizedEvent({
  normalized,
  githubToken,
  authorityEpoch: authorityEpochInput = '',
  storagePortFactory,
  isPullRequest,
  transportRunId: runId,
  authorityOwner,
  maintainer = '',
  actionConcurrency,
  projectionIdentities,
  pollCompletionUntilTerminal = true,
  authorityBusyWaitMs = 130_000,
}: BrokerPassOptions): Promise<void> {
  if (normalized.kind === 'ignored') return;
  const authorityEpoch = authorityEpochInput;
  const task = resolveTask(normalized);
  const client = createGitHubApi({ token: githubToken });
  // GITHUB_EVENT_NAME is a standard runner-provided variable (already
  // relied on by normalize()), not something this action sets itself.
  // verifyBrokerConcurrency only uses it for its own diagnostic log line
  // now: #348's third round (2026-08-04) retired the "some event types
  // self-report reliably" allowlist after issues and issue_comment -- the
  // last two events still on the direct, own-listing check -- both turned
  // out to have real, nonzero failure rates too (see the comment above
  // findConflictingRouterRun in github-api.mjs for the sampled numbers).
  // The indirect check is now unconditional, so this stays optional without
  // changing which verification path runs.
  if (actionConcurrency) {
    const { eventName, group } = actionConcurrency;
    try {
      await verifyBrokerConcurrency(client, task, runId, group, { eventName });
    } catch (error) {
      if (
        await wasSupersededEviction(
          client,
          task,
          runId,
          group,
          normalized.kind,
          error,
        )
      ) {
        return;
      }
      throw error;
    }
  }
  let loaded: LoadedLedger | undefined;
  try {
    loaded = await loadBrokerLedger(
      client,
      task,
      normalized,
      isPullRequest,
      authorityOwner,
      storagePortFactory,
      authorityEpoch,
      projectionIdentities,
      authorityBusyWaitMs,
    );
  } catch (error) {
    if (error instanceof TaskLeaseBusyError) {
      console.log(
        `::warning::Deferring ${task.repository}#${task.issue}: ${error.message}`,
      );
      throw error;
    }
    if (error instanceof CompletionBindingError) throw error;
    await failClosed(client, task, maintainer, error);
  }
  if (!loaded) {
    console.log(
      // Only reachable when loadBrokerLedger's own untrackedPullRequestControl
      // gate fired, i.e. normalized.kind === 'anchor-control' -- same
      // assumption the untyped original made without checking.
      `::notice::Ignoring ${(normalized as AnchorControlEvent).control.kind} for untracked pull ` +
        `request #${task.issue}; no dispatch ledger exists.`,
    );
    return;
  }
  try {
    if (normalized.kind === 'completion') {
      assertCompletionLedgerBinding(loaded.ledger, normalized);
    }
    await pinLedgerWhenUnoccupied(client, loaded, isPullRequest);
    try {
      // #715 (Codex P2 review of #645/#663): converge the anchor's live
      // closed/reopened state -- for a `reconcile` event, the only kind that
      // carries it (`issueClosed`, threaded from ReconcileEvent in
      // normalize.mjs) -- BEFORE giving reconcileActive() below any chance to
      // run at all. reconcileActive() can throw on an anomaly in the
      // anchor's OWN active generation that has nothing to do with whether
      // the anchor itself is closed -- most deterministically, a genuine
      // duplicate-attempt collision when more than one worker run matches
      // one generation. Previously that throw ran ahead of reconcileLedger()
      // (and therefore its own reconcileControlState() call) below, so a
      // duplicate-attempt anomaly on a closed anchor's active generation
      // permanently starved control-state convergence: every later reconcile
      // pass re-observed the identical anomaly, reconcileActive() threw
      // again before reconcileLedger() was ever reached, and control.closed
      // never became true -- the same repair-defeated-by-something-unrelated
      // shape as the outage this whole PR set out to fix. This still writes
      // through the exact same applyAnchorControl call reconcileControlState
      // (and a genuine live close event) already use -- not a second way to
      // record the fact -- and reconcileLedger's own reconcileControlState()
      // call further below simply observes an already-converged ledger and
      // no-ops, so an OPEN anchor's generation-repair work (the entire reason
      // reconcileLedger runs) still happens exactly as before.
      if (normalized.kind === 'reconcile') {
        await runPhase({ client, loaded }, 'reconciliation', () =>
          reconcileControlState(
            client,
            loaded,
            normalized.issueClosed,
            new Date().toISOString(),
            runId,
          ),
        );
      }
      await reconcileActive(
        client,
        loaded,
        new Date().toISOString(),
        maintainer,
      );
      if (normalized.kind === 'intent') {
        const accepted = await runPhase({ client, loaded }, 'intent', () =>
          acceptIntent(loaded.ledger, normalized.intent),
        );
        await saveLedger(client, loaded);
        // Before dispatching: remove any stale agent:* label a dual-label
        // self-heal identified (#304 audit item 4) -- but only when this
        // intent was accepted as the ledger's current desired state
        // (FRESH_INTENT_OUTCOMES). A duplicate/superseded/closed outcome
        // means an old or redelivered event, whose stale-label snapshot may
        // no longer reflect live GitHub state; healStaleAgentLabels'
        // is-it-actually-still-stale re-check is a second, independent
        // safeguard on top of this (PR #355 review).
        if (FRESH_INTENT_OUTCOMES.has(accepted.outcome)) {
          await healStaleAgentLabels(client, loaded, normalized.intent);
        }
      } else if (normalized.kind === 'anchor-control') {
        await applyAnchorControlTransition(client, loaded, normalized.control);
      } else if (normalized.kind === 'control-evidence') {
        recordControlEvidence(loaded.ledger, normalized.evidence);
        await saveLedger(client, loaded);
      } else if (normalized.kind === 'completion') {
        await handleCompletion(client, loaded, normalized, {
          pollUntilTerminal: pollCompletionUntilTerminal,
          maintainer,
        });
      } else if (normalized.kind === 'reconcile') {
        await runPhase({ client, loaded }, 'reconciliation', () =>
          reconcileLedger(
            client,
            loaded,
            new Date().toISOString(),
            runId,
            normalized.issueClosed,
            maintainer,
          ),
        );
      } else {
        // Unreachable given NormalizedEvent's current, exhaustively-handled
        // kinds -- this branch only guards a future kind added without a
        // matching arm here, same defensive intent as the untyped original.
        throw new Error(
          `Unsupported normalized event kind: ${(normalized as NormalizedEvent).kind}`,
        );
      }
      await dispatchAccepted(client, loaded);
      // Projector convergence checkpoint (#645 Phase 4 §5): by this point,
      // every GitHub-facing write this pass required (a needs-human park, a
      // stale-label removal) has already either succeeded or thrown -- a
      // throw would already have propagated out of this try block, so
      // reaching this line means whatever the projector owed GitHub this
      // pass, it delivered. Recording that here is what makes "has GitHub
      // caught up with the ledger" answerable from `loaded.ledger.projection`
      // without re-deriving it from the anomaly log.
      //
      // Deliberately isolated in its own try/catch rather than folded into
      // the block above: recording (or persisting) this checkpoint is itself
      // a projector/reporting concern, and #645 §5 is explicit that a
      // reporting failure must never turn an otherwise-successful pass into a
      // failed job or an extra fail-closed park -- so a failure here is
      // logged and discarded, never rethrown, and never reaches `failClosed`.
      try {
        await saveProjectionCheckpoint(client, loaded);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(
          `::warning::Failed to record the projector's convergence checkpoint: ${message}`,
        );
      }
    } catch (error) {
      await failClosed(client, task, maintainer, error);
    }
  } finally {
    if (loaded?.authority) {
      try {
        await releaseAuthority(loaded.authority, loaded.ledger);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(
          `::warning::Failed to release dispatch-storage authority lease; ` +
            `it will expire automatically: ${message}`,
        );
      }
    }
  }
}

async function broker(): Promise<void> {
  // encode()/decode() round-trip a NormalizedEvent through a GitHub Actions
  // output within this same action's own two jobs (normalize -> broker); no
  // external tamper surface beyond GitHub's own output-passing, and the
  // original decode() applied no validation here either.
  const normalized = decode(env('BROKER_PAYLOAD')) as NormalizedEvent;
  const runId = Number(env('GITHUB_RUN_ID'));
  const hostedControllerLogin = env('HOSTED_CONTROLLER_LOGIN', false);
  await admitHostedDelivery(
    {
      normalized,
      githubToken: env('GITHUB_TOKEN'),
      authorityEpoch: env('DISPATCH_AUTHORITY_EPOCH', false),
      isPullRequest: env('ANCHOR_IS_PR', false) === 'true',
      transportRunId: runId,
      authorityOwner: `action:${runId}`,
      maintainer: env('MAINTAINER_LOGIN', false),
      actionConcurrency: {
        group: env('BROKER_GROUP'),
        eventName: env('GITHUB_EVENT_NAME', false),
      },
      projectionIdentities: [
        { login: 'github-actions[bot]', type: 'Bot' },
        ...(hostedControllerLogin
          ? [{ login: hostedControllerLogin, type: 'User' as const }]
          : []),
      ],
    },
    {
      storagePortFactory: createStoragePort,
      process: processNormalizedEvent,
    },
  );
}

async function preflight(): Promise<void> {
  const task: LedgerTaskRef = {
    repositoryId: Number(env('GITHUB_REPOSITORY_ID')),
    repository: env('GITHUB_REPOSITORY'),
    issue: Number(env('BROKER_ISSUE')),
  };
  const expected: PreflightExpectation = {
    task,
    generation: Number(env('BROKER_GENERATION')),
    intentId: env('BROKER_INTENT_ID'),
    token: env('BROKER_DISPATCH_TOKEN'),
    runId: Number(env('GITHUB_RUN_ID')),
  };
  const client = api();
  const authorityPort = createStoragePort();
  // This job (a worker run's own preflight step) never writes the ledger --
  // control-plane writes are only ever made from the serialized broker job
  // (see healStaleAgentLabels' comment for the same invariant) -- so
  // `ledgerContext` stays undefined here even though a ledger IS read below;
  // a failure here is recorded only via the `::error::` annotation.
  await runPhase(undefined, 'authorization', async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const ledger = await loadPreflightLedger(task, authorityPort);
      if (ledger && verifyPreflight(ledger, expected)) {
        const generation = ledger.generations.find(
          (candidate) => candidate.generation === expected.generation,
        );
        const run: WorkflowRun = await getWorkflowRun(
          client,
          task,
          expected.runId,
        );
        // verifyPreflight() just confirmed a matching generation exists;
        // same assumption the untyped original made without re-checking.
        assertWorkerRun(
          run,
          task,
          generation as LedgerGeneration,
          workerWorkflow((generation as LedgerGeneration).pipeline),
        );
        await output('authorized', 'true');
        // Derived from the same generation/intentId preflight just verified,
        // not a new workflow input -- see action.yml's `attempt-id` output for
        // why a new required workflow_dispatch input would be both redundant
        // and a cross-repo drift hazard.
        await output(
          'attempt-id',
          formatAttemptId({
            generation: expected.generation,
            intentId: expected.intentId,
          }),
        );
        const priorTerminal = ledger.generations
          .filter(
            (candidate) =>
              candidate.generation < expected.generation &&
              [
                'completed',
                'dispatch-rejected',
                'superseded',
                'superseded-by-close',
              ].includes(candidate.state),
          )
          .sort((left, right) => right.generation - left.generation)[0];
        await output(
          'prior-terminal-state',
          JSON.stringify(
            priorTerminal
              ? {
                  generation: priorTerminal.generation,
                  state: priorTerminal.state,
                  pipeline: priorTerminal.pipeline,
                  mode: priorTerminal.mode ?? null,
                  outcome: priorTerminal.attempt?.outcome ?? null,
                  conclusion: priorTerminal.attempt?.conclusion ?? null,
                  completedAt: priorTerminal.attempt?.completedAt ?? null,
                }
              : null,
          ),
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(
      'Worker preflight could not verify an exact broker binding',
    );
  });
}

async function loadPreflightLedger(
  task: LedgerTaskRef,
  authorityPort: StoragePort,
): Promise<DispatchLedger | undefined> {
  return (await authorityPort.readTask(task))?.controllerState;
}

async function completionCallback(): Promise<void> {
  await processCompletionCallback(
    {
      issue: env('BROKER_ISSUE'),
      generation: env('BROKER_GENERATION'),
      intentId: env('BROKER_INTENT_ID'),
      token: env('BROKER_DISPATCH_TOKEN'),
      workflow: env('BROKER_WORKER_WORKFLOW'),
      oidcRequestUrl: env('ACTIONS_ID_TOKEN_REQUEST_URL'),
      oidcRequestToken: env('ACTIONS_ID_TOKEN_REQUEST_TOKEN'),
      outcome: env('BROKER_OUTCOME_KIND', false),
      outcomeReference: env('BROKER_OUTCOME_REFERENCE', false),
      readinessFailure: env('BROKER_READINESS_FAILURE', false),
    },
    {
      send: sendHostedCompletion,
    },
  );
}

type ProjectableClaudeReadinessState = Exclude<ClaudeReadinessState, 'unknown'>;

function trustedActionsRunUrl(value: string): string {
  const serverUrl = env('GITHUB_SERVER_URL').replace(/\/$/u, '');
  const repository = env('GITHUB_REPOSITORY');
  const prefix = `${serverUrl}/${repository}/actions/runs/`;
  const runId = value.startsWith(prefix) ? value.slice(prefix.length) : '';
  if (!/^\d+$/u.test(runId)) {
    throw new Error(
      'BROKER_EVIDENCE_URL must be an exact run URL in this repository',
    );
  }
  return value;
}

async function projectClaudeReadiness(
  client: GitHubApiClient,
  task: LedgerTaskRef,
  state: ProjectableClaudeReadinessState,
  evidenceUrl: string,
  maintainer: string,
): Promise<number> {
  if (state === 'credential-failure') {
    await ensureLaneReadinessAlert(
      client,
      task,
      'claude',
      'credential',
      evidenceUrl,
      maintainer,
      'probe',
    );
    return 1;
  }
  const resolved = await resolveLaneReadinessAlerts(
    client,
    task,
    'claude',
    evidenceUrl,
  );
  return resolved.length;
}

async function claudeReadiness(): Promise<void> {
  const state = env(
    'BROKER_READINESS_STATE',
  ) as ProjectableClaudeReadinessState;
  if (state !== 'credential-failure' && state !== 'healthy') {
    throw new Error(
      'BROKER_READINESS_STATE must be credential-failure or healthy',
    );
  }
  const evidenceUrl = trustedActionsRunUrl(env('BROKER_EVIDENCE_URL'));
  const task: LedgerTaskRef = {
    repositoryId: Number(env('GITHUB_REPOSITORY_ID')),
    repository: env('GITHUB_REPOSITORY'),
    // Lane incidents are repository-level health projections. The helper
    // accepts a canonical TaskRef because all other readiness callers have
    // one, but neither open nor resolve reads this sentinel issue number.
    issue: 0,
  };
  const count = await projectClaudeReadiness(
    api(),
    task,
    state,
    evidenceUrl,
    env('MAINTAINER_LOGIN', false),
  );
  await output('readiness-incidents', String(count));
}

function trustedClaudeExecutionFile(
  value: string,
  runnerTemp: string,
): string | undefined {
  if (!value || !runnerTemp) return undefined;
  const expected = path.join(runnerTemp, 'claude-execution-output.json');
  return value === expected ? expected : undefined;
}

async function classifyClaudeReadinessProbe(): Promise<void> {
  const executionFile = trustedClaudeExecutionFile(
    env('BROKER_EXECUTION_FILE', false),
    env('RUNNER_TEMP', false),
  );
  const conclusion = env('BROKER_PROBE_CONCLUSION', false);
  let execution: unknown;
  if (executionFile) {
    try {
      const stat = await fs.lstat(executionFile);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        execution = JSON.parse(
          await fs.readFile(/* turbopackIgnore: true */ executionFile, 'utf8'),
        );
      }
    } catch {
      // Missing/unparseable evidence is intentionally unknown. Never echo the
      // file or parsing error: a provider response may contain private text.
    }
  }
  await output(
    'readiness-state',
    classifyClaudeReadiness(conclusion, execution),
  );
}

// Merges both discovery lanes (#305, broadened by the #363 review):
// currently agent-labeled issues/PRs (the fast path -- covers everything
// still mid-dispatch or freshly completed) union'd with issues/PRs assigned
// to the agent fleet login (the label-independent path -- covers a ledger
// left active after its last agent:* label was removed). Deduplicated by
// issue number the same way listOpenAgentLabeledIssues dedupes across its
// own per-label queries.
async function discoverReconcileCandidates(
  client: GitHubApiClient,
  repository: string,
  fleetLogin: string,
): Promise<ReconcileIssue[]> {
  return discoverReconcileCandidatesShared(
    createReconcileTransport(client),
    repository,
    fleetLogin,
  );
}

// Closed counterpart to discoverReconcileCandidates (#715 review of
// #645/#663): the bounded closed-issue sweep needs the identical two-lane
// union its open counterpart already has, not just the labeled half. An
// anchor whose last agent:*/review:* label was removed while its worker was
// still active -- the exact case the fleet-assignee lane exists to cover on
// the open side, see listOpenIssuesAssignedTo's own header -- stays
// undiscoverable by listRecentlyClosedAgentLabeledIssues alone once
// GITHUB_TOKEN closes it, so without this lane such an anchor's
// control.closed would stay stale forever, permanently, exactly like the
// labeled gap #645 fixed. Deduplicated by issue number the same way
// discoverReconcileCandidates and each individual lane already dedupe their
// own per-label queries.
async function discoverRecentlyClosedReconcileCandidates(
  client: GitHubApiClient,
  repository: string,
  fleetLogin: string,
  now: Date | string = new Date(),
): Promise<ReconcileIssue[]> {
  return discoverRecentlyClosedReconcileCandidatesShared(
    createReconcileTransport(client),
    repository,
    fleetLogin,
    now,
  );
}

// dispatch-reconcile.yml's scan job (#305): read-only discovery of every
// open agent-labeled or fleet-assigned issue/PR (discoverReconcileCandidates)
// UNION'd with its closed counterpart, the bounded closed-issue sweep
// (discoverRecentlyClosedReconcileCandidates, above -- the closed-anchor
// convergence fix, broadened by #715's review to the same label +
// fleet-assignee two-lane shape the open side already had; see
// reconcileControlState above for what a closed candidate's own reconcile
// pass then does), deduplicated by issue number the same way each
// individual lane already dedupes its own per-label queries. Every
// resulting candidate, open or closed, gets exactly one `kind: reconcile`
// workflow_dispatch call via dispatchReconcileScan() -- the closed lane
// needs no separate dispatch kind of its own, since reconcileLedger's own
// live-state check (threaded through from normalize.mjs's ReconcileEvent)
// is what tells the two apart. A per-issue dispatch failure never blocks
// the other candidates -- every candidate always gets an attempt -- but the
// job itself still fails loud afterwards (unlike an individual reconcile's
// own bounded-retry parking, which stays green by design) so a systemic
// dispatch problem (e.g. a bad token) is visible.
async function scanReconcile(): Promise<void> {
  const client = api();
  await orchestrateReconciliation(
    {
      repository: env('GITHUB_REPOSITORY'),
      fleetLogin: env('AGENT_FLEET_LOGIN', false),
    },
    {
      transport: createReconcileTransport(client),
      run: runReconcileScan,
      writeOutput: output,
      log: console.log,
    },
  );
}

export {
  anchorNeedsHuman,
  applyAnchorControlTransition,
  assertWorkerRun,
  broker,
  classifyClaudeReadinessProbe,
  claudeReadiness,
  completionCallback,
  completionMatches,
  contextFor,
  decode,
  discoverRecentlyClosedReconcileCandidates,
  discoverReconcileCandidates,
  dispatchAccepted,
  dispatchReconcileScan,
  encode,
  FRESH_INTENT_OUTCOMES,
  handleCompletion,
  healStaleAgentLabels,
  holdForLaneReadiness,
  isDefiniteDispatchRejection,
  loadBrokerLedger,
  loadPreflightLedger,
  normalize,
  preflight,
  projectClaudeReadiness,
  RECONCILE_DISPATCH_CONCURRENCY,
  RECONCILE_MISSING_RUN_GRACE_MS,
  RECONCILE_MISSING_RUN_MAX_ATTEMPTS,
  RECONCILE_MISSING_RUN_MIN_INTERVAL_MS,
  RECONCILE_STUCK_RUN_GRACE_MS,
  RECONCILE_STUCK_RUN_MAX_ATTEMPTS,
  RECONCILE_STUCK_RUN_MIN_INTERVAL_MS,
  reconcileActive,
  reconcileControlState,
  reconcileLedger,
  repairMissingIntentFromLabel,
  resolveTask,
  runPhase,
  saveProjectionCheckpoint,
  scanReconcile,
  trustedActionsRunUrl,
  trustedClaudeExecutionFile,
  wasSupersededEviction,
};
