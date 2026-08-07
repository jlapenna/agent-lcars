import {
  formatAttemptId,
  formatFailure,
  isWellFormedFailureClassification,
} from '@agent-lcars/dispatch-contracts';

import {
  type AgentPipeline,
  type AgentRun,
  attemptMarkerFromDisplayTitle,
  duplicateLivePipelineGroups,
  type FleetSummary,
} from './agent-activity';
import {
  type DispatchLedger,
  isPlainObject,
  LEDGER_ACTIVE_GENERATION_STATES,
  type LedgerAnomaly,
  type LedgerGeneration,
} from './dispatch-ledger';
import {
  repoItemKey,
  type TaskRef,
  taskRefKey,
  taskRefUrl,
} from './watched-repo';

/**
 * The console's authoritative view models for #306 - see
 * agent-lcars#306/agent-lcars#301 for the full design. Three concepts that
 * used to be conflated into "a live run row":
 *
 * - `LogicalWork`: one canonical task (`TaskRef` - repo + issue number,
 *   never a title or a run ID). What an operator actually wants to reason
 *   about: "what is happening with issue #42."
 * - `DispatchIntentView`: one ledger generation - a request to work the
 *   task, and everything the broker recorded about how it was authorized
 *   and what happened to it (see dispatch-ledger.ts).
 * - `ExecutionAttempt`: one GitHub Actions workflow run. A generation may
 *   have zero attempts (still pending/dispatching), one normal attempt, or
 *   more than one (a genuine anomaly this model surfaces, never hides).
 *
 * `deriveLogicalWork` is the one pure join every page renders from - Command
 * Deck, Agents, and a future task detail page all call it instead of each
 * re-deriving their own notion of "what's happening with this issue."
 */

export type LogicalWorkState =
  | 'pending'
  | 'dispatching'
  | 'active'
  | 'human-needed'
  | 'completed'
  | 'anomaly'
  | 'unknown';

export type AttemptAttribution =
  'ledger' | 'run-marker' | 'legacy-title' | 'unattributed';

/** One GitHub Actions workflow run, enriched with whatever dispatch
 * lineage could be attributed to it. Every field `AgentRun` already carries
 * is still here (this is a superset, not a projection) - nothing about the
 * underlying run is lost by wrapping it. */
export interface ExecutionAttempt extends AgentRun {
  generation?: number;
  intentId?: string;
  /** The attempt's stable identity, `g<generation>:<intentId>` (#645) - one
   * field a consumer can key or link on instead of recomposing the pair
   * itself. Populated in lockstep with `generation`/`intentId` above: never
   * set when either of those is undefined, always set when both are. */
  attemptId?: string;
  /** How confidently `generation`/`intentId` are known:
   * - `ledger`: the run's `[dispatch:gN:intentId]` marker matched a real
   *   generation in this task's ledger - the strongest evidence.
   * - `run-marker`: the marker parsed, but no ledger was available to
   *   corroborate it (older issue, ledger fetch failed/degraded).
   * - `legacy-title`: only the leading `#N:` join key parsed - the run
   *   predates the broker's marker rollout.
   * - `unattributed`: no issue number parsed at all. */
  attribution: AttemptAttribution;
}

export interface DispatchIntentView {
  intentId: string;
  generation: number;
  /** From the ledger's own source evidence - why this generation exists
   * (a label add, a maintainer reply, ...). Undefined when the backing
   * source entry is missing (see `sourceKindForGeneration`). */
  sourceKind?: string;
  occurredAt: string;
  pipeline: AgentPipeline;
  mode?: string;
  state: LedgerGeneration['state'];
}

export interface LogicalWorkAnomaly {
  kind:
    | 'duplicate-active-attempts'
    | 'attempt-ledger-mismatch'
    // Anything the ledger itself recorded into `ledger.anomalies` (the
    // durable record - see `ledgerRecordedAnomalies`'s own doc comment),
    // regardless of whether a corroborating live run still exists.
    | 'ledger-recorded';
  detail: string;
}

/** `ledger-v1` when a validated ledger backs this task's intent history
 * (carrying its `revision`); `legacy` when only run attempts (marker or bare
 * title parse) are known. A discriminated union rather than two
 * independently-optional fields (`ledgerRevision?`/`provenance:`) - the two
 * were always set together (see `deriveLogicalWork`'s construction below),
 * so this lets a `kind === 'ledger-v1'` consumer read `revision` without a
 * defensive fallback for a case that could never actually happen. */
export type LogicalWorkProvenance =
  { kind: 'ledger-v1'; revision: number } | { kind: 'legacy' };

export interface LogicalWork {
  task: TaskRef;
  title: string;
  url: string;
  selectedPipeline?: AgentPipeline;
  state: LogicalWorkState;
  /** Oldest generation first - reads as the task's history in order. */
  intents: DispatchIntentView[];
  /** Every workflow run attributed to this task, oldest first. Never
   * shrunk by grouping - a duplicate/retry keeps every attempt visible. */
  attempts: ExecutionAttempt[];
  anomalies: LogicalWorkAnomaly[];
  provenance: LogicalWorkProvenance;
}

/** Bare title/url metadata for a task, independent of whether it currently
 * has any live or recent attempts - the open-item board (action-items.ts)
 * is the usual source, but any caller with a title/url pair for a task can
 * supply one (e.g. a future closed-item detail fetch). */
export interface TaskMeta {
  repo: TaskRef['repository'];
  issueNumber: number;
  title: string;
  url: string;
  /** Mirrors `ActionItem.actionTypes.includes('needs-human')` - a maintainer
   * decision is blocking progress regardless of what the ledger/attempts
   * say, so it outranks a merely-active/pending dispatch state (see
   * `LOGICAL_STATE_PRIORITY`) but never masks a genuine attempt anomaly. */
  humanNeeded?: boolean;
}

const LOGICAL_STATE_PRIORITY: Record<LogicalWorkState, number> = {
  anomaly: 0,
  'human-needed': 1,
  active: 2,
  dispatching: 3,
  pending: 4,
  completed: 5,
  unknown: 6,
};

/** Maps a ledger generation's state onto the coarser `LogicalWorkState` the
 * UI reasons about - see LEDGER_ACTIVE_GENERATION_STATES for which raw
 * states count as "active" here. */
function stateForGeneration(
  state: LedgerGeneration['state'],
): LogicalWorkState {
  if (state === 'pending' || state === 'accepted') return 'pending';
  if (state === 'dispatching' || state === 'dispatch-unknown') {
    return 'dispatching';
  }
  if (LEDGER_ACTIVE_GENERATION_STATES.has(state)) return 'active';
  if (state === 'completed' || state === 'dispatch-rejected') {
    return 'completed';
  }
  // superseded / superseded-by-close: not the newest word on the task.
  return 'unknown';
}

/** The ledger's own view of task state: the active generation wins over a
 * merely-pending one, and the newest generation overall wins when nothing
 * is active/pending (a task that finished its last generation reads as
 * `completed`, not `unknown`). */
function stateFromLedger(ledger: DispatchLedger): LogicalWorkState {
  const active = ledger.generations.find((g) =>
    LEDGER_ACTIVE_GENERATION_STATES.has(g.state),
  );
  if (active) return stateForGeneration(active.state);
  const pending = ledger.generations.find((g) => g.state === 'pending');
  if (pending) return 'pending';
  const latest = ledger.generations.at(-1);
  return latest ? stateForGeneration(latest.state) : 'unknown';
}

/** Fallback state when no ledger backs this task - derived from the raw
 * attempts alone, matching what the console showed before the ledger
 * existed (any running/queued attempt means work is in flight). */
function stateFromAttempts(attempts: ExecutionAttempt[]): LogicalWorkState {
  if (attempts.some((a) => a.status === 'running')) return 'active';
  if (attempts.some((a) => a.status === 'queued')) return 'dispatching';
  if (attempts.length > 0) return 'completed';
  return 'unknown';
}

function toExecutionAttempt(run: AgentRun): ExecutionAttempt {
  const marker = attemptMarkerFromDisplayTitle(run.displayTitle);
  if (marker) {
    return {
      ...run,
      generation: marker.generation,
      intentId: marker.intentId,
      // The marker IS `formatAttemptId(marker)` in brackets (see marker.js),
      // so re-deriving it here from the same parsed pair is exact, not a
      // guess - there is no ledger yet at this point in the join to have
      // persisted a competing value.
      attemptId: formatAttemptId(marker),
      attribution: 'run-marker',
    };
  }
  return {
    ...run,
    attribution:
      run.issueNumber === undefined ? 'unattributed' : 'legacy-title',
  };
}

/** Attaches ledger-sourced generation/intent data to attempts already
 * carrying a run-marker, upgrading their attribution to `ledger` once
 * corroborated. An attempt whose marker names a generation absent from the
 * ledger (out-of-order arrival, a stale/rotated ledger) keeps its
 * `run-marker` attribution and raises a `attempt-ledger-mismatch` anomaly
 * instead of silently trusting the marker or dropping the attempt. */
function attributeAttemptsToLedger(
  attempts: ExecutionAttempt[],
  ledger: DispatchLedger | undefined,
): { attempts: ExecutionAttempt[]; anomalies: LogicalWorkAnomaly[] } {
  if (!ledger) return { attempts, anomalies: [] };
  const anomalies: LogicalWorkAnomaly[] = [];
  const byIntentId = new Map(ledger.generations.map((g) => [g.intentId, g]));
  const attributed = attempts.map((attempt) => {
    if (attempt.intentId === undefined) return attempt;
    const generation = byIntentId.get(attempt.intentId);
    if (!generation) {
      anomalies.push({
        kind: 'attempt-ledger-mismatch',
        detail: `Run ${attempt.id} carries intent ${attempt.intentId}, which is not in this task's ledger.`,
      });
      return attempt;
    }
    if (generation.generation !== attempt.generation) {
      anomalies.push({
        kind: 'attempt-ledger-mismatch',
        detail: `Run ${attempt.id}'s marker claims generation ${attempt.generation}, but intent ${attempt.intentId} is ledger generation ${generation.generation}.`,
      });
    }
    return {
      ...attempt,
      generation: generation.generation,
      // Prefer the ledger's own persisted `attempt.attemptId` (written once
      // at `beginDispatch`, see broker.mjs) over re-deriving it here: that
      // field is the immutable record of what the broker actually minted,
      // whereas recomputing from `generation` is only ever a reconstruction
      // of it. Fall back to `formatAttemptId` for a generation dispatched
      // before this field existed - the derivation agrees with the marker by
      // construction (marker.js), so it is exact, not a guess, for those too.
      attemptId: generation.attempt?.attemptId ?? formatAttemptId(generation),
      attribution: 'ledger' as const,
    };
  });
  return { attempts: attributed, anomalies };
}

/** Same-pipeline duplicates are the anomaly worth calling out explicitly -
 * two different pipelines racing the same issue is already a distinct,
 * intentional condition the UI shows separately (see
 * agent-activity-panel.tsx's cross-pipeline grouping), not a dispatch bug. */
function duplicateAttemptAnomalies(
  attempts: ExecutionAttempt[],
): LogicalWorkAnomaly[] {
  const anomalies: LogicalWorkAnomaly[] = [];
  for (const [pipeline, group] of duplicateLivePipelineGroups(attempts)) {
    anomalies.push({
      kind: 'duplicate-active-attempts',
      detail: `${group.length} ${pipeline} attempts are queued or running for the same task at once (run ${group.map((a) => a.id).join(', ')}).`,
    });
  }
  return anomalies;
}

/**
 * Turns one raw `ledger.anomalies` entry into readable text without
 * assuming its `detail` shape - `detail` is broker-kind-specific and
 * untyped (see `LedgerAnomaly`'s own doc comment). `duplicate-attempt` (the
 * one kind that exists today - `main.mjs`'s `reconcileActive`, recorded
 * when the reconciler finds more than one worker run bound to a single
 * generation) gets a tailored message; anything else - including anomaly
 * kinds a future broker change adds (e.g. #305's reconciler introduces
 * `reconcile-missing-run`/`reconcile-parked`/`reconcile-invariant-violation`)
 * - still renders instead of being silently dropped or crashing.
 *
 * #645 layers a `failure` classification (owning system, phase, reason
 * code, retry disposition) onto an anomaly alongside its pre-existing
 * `kind`/`detail`. When present, its `formatFailure` one-liner is appended
 * verbatim - reusing the same rendering the broker's own logs/annotations
 * use rather than re-deriving a second layout that could drift from it.
 * Older ledgers (recorded before this field existed) carry no `failure` at
 * all, and this must keep rendering exactly as it did before for those.
 */
function describeLedgerAnomaly(anomaly: LedgerAnomaly): string {
  const message = (() => {
    if (
      anomaly.kind === 'duplicate-attempt' &&
      isPlainObject(anomaly.detail) &&
      Number.isSafeInteger(anomaly.detail.generation) &&
      Array.isArray(anomaly.detail.runIds)
    ) {
      const runIds = anomaly.detail.runIds.join(', ');
      return `The dispatch ledger recorded a duplicate-attempt anomaly for generation ${anomaly.detail.generation}: runs ${runIds} were both bound to it.`;
    }
    const detail =
      isPlainObject(anomaly.detail) || Array.isArray(anomaly.detail)
        ? ` ${JSON.stringify(anomaly.detail)}`
        : '';
    return `The dispatch ledger recorded a "${anomaly.kind}" anomaly at ${anomaly.occurredAt}.${detail}`;
  })();
  // The shared read-side gate (`isWellFormedAnomaly`) already validates any
  // `failure` against the real vocabularies before a ledger gets this far, so
  // this re-check is defence in depth for the interpolation site rather than
  // the primary guard -- and it is the shared validator, not a weaker local
  // copy of it, which is what this whole issue is about.
  if (!isWellFormedFailureClassification(anomaly.failure)) return message;
  return `${message} ${formatFailure(anomaly.failure)}`;
}

/**
 * Anomalies the ledger itself already recorded (broker.mjs's `addAnomaly`,
 * e.g. the reconciler catching two worker runs bound to one generation -
 * see `describeLedgerAnomaly`). These are the durable record: unlike
 * `duplicateAttemptAnomalies` above (derived fresh from *currently live*
 * attempts on every render), a ledger-recorded anomaly stays visible even
 * after its duplicate run has completed or aged out of the recent-run
 * window this app can still see - unconditionally surfaced, never
 * re-derived or gated on a live run still existing.
 */
function ledgerRecordedAnomalies(ledger: DispatchLedger): LogicalWorkAnomaly[] {
  return ledger.anomalies.map((anomaly) => ({
    kind: 'ledger-recorded',
    detail: describeLedgerAnomaly(anomaly),
  }));
}

function intentsFromLedger(ledger: DispatchLedger): DispatchIntentView[] {
  // Built once rather than calling `sourceKindForGeneration` (an O(sources)
  // `.find()`) per generation - same "build a Map once, look up per
  // element" pattern `attributeAttemptsToLedger` above already establishes
  // for the same shape of problem.
  const bySourceId = new Map(
    ledger.sources.map((source) => [source.sourceId, source]),
  );
  return (
    ledger.generations
      // The broker's no-op production canary is valid ledger history, but it
      // is not a selectable coding-agent intent and has no UI integration.
      .filter(
        (
          generation,
        ): generation is LedgerGeneration & {
          pipeline: AgentPipeline;
        } => generation.pipeline !== 'canary',
      )
      .slice()
      .sort((a, b) => a.generation - b.generation)
      .map((generation) => ({
        intentId: generation.intentId,
        generation: generation.generation,
        sourceKind: bySourceId.get(generation.sourceId)?.sourceKind,
        occurredAt: generation.occurredAt,
        pipeline: generation.pipeline,
        mode: generation.mode,
        state: generation.state,
      }))
  );
}

/** The pipeline selected by the newest non-superseded generation, falling
 * back to the pipeline of the newest attempt when no ledger is available -
 * matches `selectedAgentPipeline`'s "no implicit precedence" spirit: this
 * is presentation-only (which badge a card leads with), never a control
 * decision. */
function selectedPipeline(
  ledger: DispatchLedger | undefined,
  attempts: ExecutionAttempt[],
): AgentPipeline | undefined {
  if (ledger) {
    // `findLast` reads the newest non-superseded generation without
    // allocating a throwaway filtered array just to read its last element.
    const newest =
      ledger.generations.findLast(
        (g) => g.state !== 'superseded' && g.state !== 'superseded-by-close',
      ) ?? ledger.generations.at(-1);
    if (newest?.pipeline !== 'canary') return newest?.pipeline;
  }
  return attempts.at(-1)?.pipeline;
}

export interface DeriveLogicalWorkInput {
  /** Raw workflow runs (live and/or recent) for every watched repo -
   * ungrouped, exactly as `agent-activity.ts` fetches them. */
  attempts: AgentRun[];
  /** Parsed, validated ledgers keyed by `repoItemKey(repo, issueNumber)`.
   * Absent for a task with no ledger yet (pre-broker issue, or the comment
   * scan hasn't found one) - `deriveLogicalWork` degrades that task to
   * `legacy` provenance rather than failing. */
  ledgers: Map<string, DispatchLedger>;
  /** Title/url metadata keyed the same way - normally every open board item,
   * so a task with attempts but no open-item metadata still renders (title
   * falls back to the run's own display title). */
  taskMeta: Map<string, TaskMeta>;
}

export interface DeriveLogicalWorkResult {
  work: LogicalWork[];
  /** Attempts whose issue number could not be parsed at all (predate the
   * run-name rollout). These have no safe `TaskRef` to attach to, so they
   * are never folded into a `LogicalWork` by guesswork (e.g. title
   * matching) - callers render them in their own "unattributed" group. */
  unattributedAttempts: ExecutionAttempt[];
}

/**
 * The one pure join every page should render `LogicalWork` from. Combines
 * raw execution attempts (liveness/status truth) with ledger data (intent
 * lineage truth) without letting either source silently override or hide
 * the other - see this module's own top-of-file doc comment.
 */
export function deriveLogicalWork(
  input: DeriveLogicalWorkInput,
): DeriveLogicalWorkResult {
  const byKey = new Map<
    string,
    { task: TaskRef; attempts: ExecutionAttempt[] }
  >();
  const unattributedAttempts: ExecutionAttempt[] = [];

  for (const run of input.attempts) {
    const attempt = toExecutionAttempt(run);
    if (run.issueNumber === undefined) {
      unattributedAttempts.push(attempt);
      continue;
    }
    const task: TaskRef = {
      repository: run.repo,
      issueNumber: run.issueNumber,
    };
    const key = taskRefKey(task);
    const existing = byKey.get(key);
    if (existing) existing.attempts.push(attempt);
    else byKey.set(key, { task, attempts: [attempt] });
  }

  // A task can also exist purely because it has a ledger (pending/
  // dispatching, zero attempts materialized yet) or purely because it has
  // open-item metadata (idle work with no ledger and no attempts at all -
  // included so a caller can still ask "what state is #42 in" uniformly).
  for (const [key, ledger] of input.ledgers) {
    if (!byKey.has(key)) {
      byKey.set(key, { task: taskRefFromLedger(ledger), attempts: [] });
    }
  }
  for (const [key, meta] of input.taskMeta) {
    if (!byKey.has(key)) {
      byKey.set(key, {
        task: { repository: meta.repo, issueNumber: meta.issueNumber },
        attempts: [],
      });
    }
  }

  const work: LogicalWork[] = [];
  for (const [key, entry] of byKey) {
    const task = entry.task;
    const ledger = input.ledgers.get(key);
    const meta = input.taskMeta.get(key);
    const sortedAttempts = entry.attempts
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const { attempts, anomalies: mismatchAnomalies } =
      attributeAttemptsToLedger(sortedAttempts, ledger);

    const anomalies: LogicalWorkAnomaly[] = [
      ...mismatchAnomalies,
      ...duplicateAttemptAnomalies(attempts),
      // Durable ledger-recorded anomalies (see that function's own doc
      // comment) - included unconditionally, not just when a live run
      // still corroborates them, so a duplicate the reconciler caught and
      // has since resolved (completed run, or aged out of the recent-run
      // window) is still explained rather than silently disappearing.
      ...(ledger ? ledgerRecordedAnomalies(ledger) : []),
    ];

    const baseState = ledger
      ? stateFromLedger(ledger)
      : stateFromAttempts(attempts);
    // Any anomaly - fresh (duplicate live attempts, a marker/ledger
    // mismatch) or durable (a ledger-recorded anomaly, possibly from a
    // duplicate that has since completed or aged out of the visible run
    // window) - promotes the whole task to the distinct `anomaly` state.
    // A ledger-recorded anomaly has no "resolved" signal in the schema
    // (broker.mjs's `anomalies` array is append-only), so this stays true
    // until the underlying issue itself closes - deliberately: an operator
    // who hasn't looked at a flagged duplicate yet should keep seeing it
    // flagged, not have it quietly stop being called out.
    const state: LogicalWorkState =
      anomalies.length > 0
        ? 'anomaly'
        : (meta?.humanNeeded ?? false)
          ? 'human-needed'
          : baseState;

    const fallbackAttempt = attempts.at(-1);
    work.push({
      task,
      title:
        meta?.title ?? fallbackAttempt?.displayTitle ?? `#${task.issueNumber}`,
      url: meta?.url ?? taskRefUrl(task),
      selectedPipeline: selectedPipeline(ledger, attempts),
      state,
      intents: ledger ? intentsFromLedger(ledger) : [],
      attempts,
      anomalies,
      provenance: ledger
        ? { kind: 'ledger-v1', revision: ledger.revision }
        : { kind: 'legacy' },
    });
  }

  work.sort(
    (a, b) => LOGICAL_STATE_PRIORITY[a.state] - LOGICAL_STATE_PRIORITY[b.state],
  );

  return { work, unattributedAttempts };
}

/** `ledger.task.repository` is broker.mjs's `"owner/name"` string form (see
 * `assertTaskRef` in broker.mjs); this app's `TaskRef.repository` is the
 * `{owner, name}` shape `RepositoryRef` declares. Only a task that exists
 * purely because it has a ledger (no attempt, no open-item metadata) needs
 * this conversion - every other path already has a real
 * `WatchedRepo`/`RepositoryRef` object from the attempt or task-meta side. */
function taskRefFromLedger(ledger: DispatchLedger): TaskRef {
  const [owner, name] = ledger.task.repository.split('/');
  return {
    repository: { owner: owner ?? ledger.task.repository, name: name ?? '' },
    issueNumber: ledger.task.issue,
  };
}

export interface ActivityMetrics {
  /** Distinct tasks with in-flight logical work - never a run count. */
  logicalTaskCount: number;
  /** Raw workflow attempts currently queued, across every task. */
  queuedAttempts: number;
  /** Raw workflow attempts currently running, across every task. */
  runningAttempts: number;
  /** From `listSelfHostedRunnersForRepo` - physical capacity, not work.
   * Undefined when the runner API was unavailable (matches `FleetSummary`
   * itself being optional). */
  onlineRunners?: number;
  busyRunners?: number;
}

const IN_FLIGHT_STATES = new Set<LogicalWorkState>([
  'pending',
  'dispatching',
  'active',
  'human-needed',
  'anomaly',
]);

/**
 * The three metrics #306 requires stay visibly distinct: how much logical
 * work exists, how many physical attempts are consuming (or waiting for) a
 * runner right now, and how many runners physically exist. None of these is
 * a substitute for another - a queued attempt consumes no runner, and one
 * logical task can have zero, one, or several attempts (see this module's
 * own top comment).
 */
export function deriveActivityMetrics(
  work: LogicalWork[],
  attempts: ExecutionAttempt[],
  fleet?: FleetSummary,
): ActivityMetrics {
  // One pass rather than two separate `.filter(...).length` calls - this
  // runs on every /agents page render over the full flattened attempt list
  // across every watched repo, so it's worth counting both statuses
  // together instead of scanning `attempts` twice.
  let queuedAttempts = 0;
  let runningAttempts = 0;
  for (const attempt of attempts) {
    if (attempt.status === 'queued') queuedAttempts++;
    else if (attempt.status === 'running') runningAttempts++;
  }
  return {
    logicalTaskCount: work.filter((w) => IN_FLIGHT_STATES.has(w.state)).length,
    queuedAttempts,
    runningAttempts,
    onlineRunners: fleet?.online,
    busyRunners: fleet?.busy,
  };
}

/** Builds both `ledgers`/`taskMeta` input maps `deriveLogicalWork` needs from
 * the open-item board, keyed consistently with the attempt side via
 * `repoItemKey` - one pass over `items` rather than two independent loops
 * (a caller building both used to call a `ledgerMapFromItems` and a
 * `taskMetaFromItems` that each re-walked the same list). Kept here (not in
 * action-items.ts) so that module stays free of any dispatch-ledger-shaped
 * type - it only ever hands back the raw `DispatchLedger` an item's
 * enrichment already parsed. */
export function ledgerAndTaskMetaFromItems(
  items: {
    repo: TaskRef['repository'];
    number: number;
    title: string;
    url: string;
    humanNeeded?: boolean;
    ledger?: DispatchLedger;
  }[],
): { ledgers: Map<string, DispatchLedger>; taskMeta: Map<string, TaskMeta> } {
  const ledgers = new Map<string, DispatchLedger>();
  const taskMeta = new Map<string, TaskMeta>();
  for (const item of items) {
    const key = repoItemKey(item.repo, item.number);
    if (item.ledger) ledgers.set(key, item.ledger);
    taskMeta.set(key, {
      repo: item.repo,
      issueNumber: item.number,
      title: item.title,
      url: item.url,
      humanNeeded: item.humanNeeded,
    });
  }
  return { ledgers, taskMeta };
}
