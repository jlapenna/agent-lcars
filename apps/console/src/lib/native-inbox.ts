import 'server-only';

import { fleetTriageReportSchema } from '@agent-lcars/dispatch-contracts';
import { logger } from '@agent-lcars/logging';
import {
  type OrchestratorStore,
  readFullRunMessage,
  type TaskId,
  taskKey,
  withFullRunMessages,
} from '@agent-lcars/orchestrator';
import { isSourceManagedWork } from '@agent-lcars/work';
import { toWorkSummary } from '@agent-lcars/work/derive';

import {
  type NativeDecisionCard,
  nativeReportRun,
  REPORT_INBOX_WINDOW_MS,
} from '../app/inbox-card';
import { readHandoffActions } from './handoff-summary-work';
import { shareInFlight } from './in-flight';
import type { WorkPrincipal } from './work-auth';
import { forbiddenReason } from './work-mint';

/** Native tasks read per page. Each page costs two sequential round trips
 * (the tasks, then one batched read of their runs), so a page holds the
 * whole current set (about 440 tasks on 2026-11-25) rather than 200. */
const NATIVE_TASK_PAGE = 1000;

/** Scan bounded datastore pages so older human decisions never disappear
 * behind newer completed work. GitHub parks use their existing projection,
 * giving an anchor represented by both a task and a label exactly one row.
 * A report that settled within REPORT_INBOX_WINDOW_MS is listed too; older
 * ones stay readable from Work. */
export function getNativeInboxCards(
  store: OrchestratorStore,
  principal: WorkPrincipal | undefined,
  selectedItemKey?: string,
  now?: number,
): Promise<NativeDecisionCard[]> {
  // Bridge and the frame's inbox count read the same cards at the same
  // moment; share a read in flight (in-flight.ts). Cards depend on the
  // principal (Reply), so its grant is part of the key.
  if (selectedItemKey !== undefined || now !== undefined)
    return readNativeInboxCards(store, principal, selectedItemKey, now);
  const grant = principal
    ? JSON.stringify([
        principal.principal,
        [...principal.scopes].sort(),
        [...principal.pipelines].sort(),
        principal.sourceRepository ?? null,
      ])
    : 'anonymous';
  return shareInFlight(`native-inbox-cards:${grant}`, () =>
    readNativeInboxCards(store, principal),
  );
}

async function readNativeInboxCards(
  store: OrchestratorStore,
  principal: WorkPrincipal | undefined,
  selectedItemKey?: string,
  now = Date.now(),
): Promise<NativeDecisionCard[]> {
  const cards: NativeDecisionCard[] = [];
  for (const work of await inboxCandidates(store, selectedItemKey, now)) {
    const card = await cardFor(store, principal, work, selectedItemKey, now);
    if (card) cards.push(card);
  }
  return cards;
}

/**
 * The native items that can produce a card, newest first. Without a selected
 * item that is only a task whose latest run parked, or whose latest run is a
 * report settled within the Inbox window, so the candidates come from the
 * runs that reported `park` or `report` rather than from every native task
 * and run (436 tasks and their runs on 2026-11-25, read on every Bridge,
 * Inbox and frame render). A selected item may be any task, so it keeps the
 * full scan.
 */
async function inboxCandidates(
  store: OrchestratorStore,
  selectedItemKey: string | undefined,
  now: number,
): Promise<ReturnType<typeof toWorkSummary>[]> {
  if (selectedItemKey !== undefined) return allNativeWork(store);
  const [parks, reports] = await Promise.all([
    store.listRunsWithSummary('park'),
    store.listRunsWithSummary('report'),
  ]);
  const ids = new Map<string, TaskId>();
  for (const run of parks)
    if ('workId' in run.task) ids.set(taskKey(run.task), run.task);
  for (const run of reports)
    if (
      'workId' in run.task &&
      now - Date.parse(run.updatedAt) <= REPORT_INBOX_WINDOW_MS
    )
      ids.set(taskKey(run.task), run.task);
  if (ids.size === 0) return [];
  const [tasks, runsByTask] = await Promise.all([
    store.readTasks([...ids.values()]),
    store.listRunsForTasks([...ids.values()]),
  ]);
  return [...tasks.values()]
    .sort((a, b) => workIdOf(b).localeCompare(workIdOf(a)))
    .map(({ task }) =>
      toWorkSummary({ task, runs: runsByTask.get(taskKey(task.task)) ?? [] }),
    );
}

/** Sorting by work id (a ULID) descending puts the newest first, the order
 * `listNativeTasks` returns. */
function workIdOf(entry: { task: { task: TaskId } }): string {
  const id = entry.task.task;
  return 'workId' in id ? id.workId : '';
}

async function allNativeWork(
  store: OrchestratorStore,
): Promise<ReturnType<typeof toWorkSummary>[]> {
  const work: ReturnType<typeof toWorkSummary>[] = [];
  let cursor: string | undefined;
  do {
    const tasks = await store.listNativeTasks(NATIVE_TASK_PAGE, cursor);
    // One batched read of the page's run history, not a query per task.
    const runsByTask = await store.listRunsForTasks(
      tasks.map(({ task }) => task.task),
    );
    for (const { task } of tasks)
      work.push(
        toWorkSummary({ task, runs: runsByTask.get(taskKey(task.task)) ?? [] }),
      );
    const last = tasks.at(-1)?.task.task;
    cursor =
      tasks.length === NATIVE_TASK_PAGE && last && 'workId' in last
        ? last.workId
        : undefined;
  } while (cursor !== undefined);
  return work;
}

/** The card one native item produces, if any. */
async function cardFor(
  store: OrchestratorStore,
  principal: WorkPrincipal | undefined,
  work: ReturnType<typeof toWorkSummary>,
  selectedItemKey: string | undefined,
  now: number,
): Promise<NativeDecisionCard | undefined> {
  const closedSource =
    work.issue?.reference.tracker === 'linear' && work.issue.state === 'closed';
  if (closedSource && work.id !== selectedItemKey) return undefined;
  const sourceManaged = isSourceManagedWork({
    origin: work.origin,
    spec: work.spec,
  });
  let triageDecision = false;
  if (sourceManaged && work.issue?.reference.tracker === 'linear') {
    try {
      const latest = work.runs.at(-1);
      const report = fleetTriageReportSchema.parse(
        JSON.parse((latest && (await readFullRunMessage(store, latest))) ?? ''),
      );
      triageDecision = ['needs-owner', 'needs-evidence'].includes(
        report.disposition,
      );
    } catch {
      /* An unavailable report does not invent a human decision. */
    }
  }
  if ('sourceKey' in work.spec || (sourceManaged && !triageDecision))
    return undefined;
  const report = nativeReportRun(work);
  const freshReport =
    report !== undefined &&
    now - Date.parse(report.updatedAt) <= REPORT_INBOX_WINDOW_MS;
  if (
    !('workId' in work.anchor) ||
    (work.state !== 'parked' && !freshReport && work.id !== selectedItemKey)
  )
    return undefined;
  const latest = work.runs.at(-1);
  let humanNeededActions = latest?.result?.humanNeededActions;
  try {
    if (latest !== undefined && work.state === 'parked')
      humanNeededActions = await readHandoffActions(store, latest);
  } catch {
    logger.warn('agent-lcars: human-needed summary read unavailable');
  }
  // Repository jobs expose artifacts and invocation through Jobs; coding
  // replies must not create a second attempt of an effectful occurrence.
  if (work.spec.pipeline === 'goose') return undefined;
  return {
    humanNeededActions,
    // A card shows the whole report or question, never the preview.
    work: {
      ...work,
      anchor: work.anchor,
      // Only the latest round is shown (its report or parked question).
      runs: [
        ...work.runs.slice(0, -1),
        ...(await withFullRunMessages(store, work.runs.slice(-1), (runId) =>
          logger.error(
            'agent-lcars: stored final message unreadable for run %s; serving its preview',
            runId,
          ),
        )),
      ],
    },
    kind: report ? 'report' : 'decision',
    queued: !closedSource && (work.state === 'parked' || freshReport),
    // A follow-up on a report starts a new round, as a reply to a park does.
    canReply:
      !closedSource &&
      !sourceManaged &&
      (work.state === 'parked' || report !== undefined) &&
      principal?.scopes.has('work.operator') === true &&
      forbiddenReason(principal, {
        ...work.spec,
        pipeline: (work.runs.at(-1)?.pipeline ??
          work.spec.pipeline) as typeof work.spec.pipeline,
      }) === undefined,
  };
}

/** Optional Bridge evidence must not reject its GitHub rendering boundary. */
export async function getNativeInboxEvidence(
  load: () => Promise<{
    store: OrchestratorStore;
    principal: WorkPrincipal | undefined;
  }>,
): Promise<{
  cards: NativeDecisionCard[];
  available: boolean;
  warnings: string[];
}> {
  try {
    const { store, principal } = await load();
    return {
      cards: await getNativeInboxCards(store, principal),
      available: true,
      warnings: [],
    };
  } catch (error) {
    logger.error('agent-lcars: native Inbox count unavailable:', error);
    return {
      cards: [],
      available: false,
      warnings: [
        'Native decisions unavailable; the Inbox count includes GitHub decisions only.',
      ],
    };
  }
}
