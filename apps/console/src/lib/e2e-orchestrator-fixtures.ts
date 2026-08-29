import 'server-only';

import { type Run, type Task, taskKey } from '@agent-lcars/orchestrator';
import { required } from '@agent-lcars/util-server';
import { Firestore } from '@google-cloud/firestore';

import { E2E_FIXTURE_REPO, E2E_ITEM_NUMBERS } from './e2e-github-fixtures';

const COLLECTION_PREFIX = 'orchestrator-';
const COLLECTIONS = ['tasks', 'runs', 'outbox'] as const;
const REPOSITORY = `${E2E_FIXTURE_REPO.owner}/${E2E_FIXTURE_REPO.name}`;

/** Stable ids let the telemetry fixture join the exact authoritative Run it
 * describes. They are broker ids, not stand-in GitHub Actions ids. */
export const E2E_ORCHESTRATOR_RUN_IDS = {
  running: `${REPOSITORY}#${E2E_ITEM_NUMBERS.duplicateDispatch}/r1`,
  queuedWaiting: `${REPOSITORY}#9009/r1`,
  duplicateQueued: `${REPOSITORY}#${E2E_ITEM_NUMBERS.duplicateDispatch}/r2`,
  succeeded: `${REPOSITORY}#${E2E_ITEM_NUMBERS.reviewRequested}/r1`,
  failed: `${REPOSITORY}#${E2E_ITEM_NUMBERS.humanNeeded}/r1`,
  timedOut: `${REPOSITORY}#${E2E_ITEM_NUMBERS.readyForAgent}/r1`,
  silentError: `${REPOSITORY}#${E2E_ITEM_NUMBERS.silentError}/r1`,
  opencodeSucceeded: `${REPOSITORY}#9007/r1`,
  olderSucceeded: `${REPOSITORY}#${E2E_ITEM_NUMBERS.reviewRequested}/r2`,
  olderFailed: `${REPOSITORY}#${E2E_ITEM_NUMBERS.humanNeeded}/r2`,
} as const;

type FixturePipeline = 'claude' | 'codex' | 'opencode';
type FixtureState = Run['state'];

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const minutesFromNow = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

function fixtureFirestore(): Firestore {
  return new Firestore({
    projectId: required('PROJECT_ID'),
    databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
  });
}

function taskFor(input: {
  issue: number;
  title: string;
  pipeline: FixturePipeline;
  runCount: number;
  activeRunId?: string;
  updatedAt: string;
}): Task {
  return {
    task: { repo: REPOSITORY, issue: input.issue },
    ...(input.activeRunId === undefined
      ? {}
      : { activeRunId: input.activeRunId }),
    runCount: input.runCount,
    work: {
      origin: { principal: 'github:e2e-fixture', channel: 'github' },
      spec: {
        title: input.title,
        description: 'Authoritative E2E fixture work.',
        pipeline: input.pipeline,
        target: { repo: REPOSITORY },
      },
    },
    updatedAt: input.updatedAt,
  };
}

function runFor(input: {
  runId: string;
  issue: number;
  pipeline: FixturePipeline;
  state: FixtureState;
  createdAt: string;
  updatedAt: string;
  result?: boolean;
  queue?: 'queued' | 'claimed';
}): Run {
  const initialEvent = {
    at: input.createdAt,
    to: 'pending' as const,
    by: 'request' as const,
  };
  const terminal =
    input.state === 'finished'
      ? {
          result: { ok: input.result ?? false },
          events: [
            ...[initialEvent],
            {
              at: input.updatedAt,
              to: 'finished' as const,
              by: 'report' as const,
            },
          ],
        }
      : input.state === 'canceled'
        ? {
            events: [
              ...[initialEvent],
              {
                at: input.updatedAt,
                to: 'canceled' as const,
                by: 'operator' as const,
              },
            ],
          }
        : input.state === 'running'
          ? {
              events: [
                ...[initialEvent],
                {
                  at: input.updatedAt,
                  to: 'running' as const,
                  by: 'dispatch' as const,
                },
              ],
            }
          : { events: [initialEvent] };
  return {
    runId: input.runId,
    task: { repo: REPOSITORY, issue: input.issue },
    state: input.state,
    pipeline: input.pipeline,
    requestId: `e2e-fixture:${input.runId}`,
    executor: 'queue',
    ...(input.queue === undefined
      ? {}
      : {
          queue:
            input.queue === 'queued'
              ? { state: 'queued' as const }
              : {
                  state: 'claimed' as const,
                  claimedAt: input.updatedAt,
                  claimedBy: 'e2e-fixture',
                  tokenHash: 'e'.repeat(64),
                },
        }),
    leaseExpiresAt: minutesFromNow(90),
    ...terminal,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

/**
 * The populated dashboard fixture is deliberately expressed as durable broker
 * Tasks and Runs. The duplicate live pair is written directly because the
 * real admission mutex correctly prevents an API client from creating that
 * anomalous state; the UI must still render it when it already exists.
 */
function populatedFixture() {
  const timestamps = {
    runningCreated: minutesAgo(13),
    runningUpdated: minutesAgo(1),
    duplicateQueued: minutesAgo(11),
    queuedWaiting: minutesAgo(2),
    succeeded: minutesAgo(41),
    failed: minutesAgo(88),
    timedOut: minutesAgo(120),
    silentError: minutesAgo(52),
    opencodeSucceeded: minutesAgo(140),
    olderSucceeded: minutesAgo(165),
    olderFailed: minutesAgo(180),
  };
  const runs = [
    runFor({
      runId: E2E_ORCHESTRATOR_RUN_IDS.running,
      issue: E2E_ITEM_NUMBERS.duplicateDispatch,
      pipeline: 'claude',
      state: 'running',
      createdAt: timestamps.runningCreated,
      updatedAt: timestamps.runningUpdated,
    }),
    runFor({
      runId: E2E_ORCHESTRATOR_RUN_IDS.queuedWaiting,
      issue: 9009,
      pipeline: 'claude',
      state: 'pending',
      createdAt: timestamps.queuedWaiting,
      updatedAt: timestamps.queuedWaiting,
      queue: 'queued',
    }),
    runFor({
      runId: E2E_ORCHESTRATOR_RUN_IDS.duplicateQueued,
      issue: E2E_ITEM_NUMBERS.duplicateDispatch,
      pipeline: 'claude',
      state: 'pending',
      createdAt: timestamps.duplicateQueued,
      updatedAt: timestamps.duplicateQueued,
      queue: 'queued',
    }),
    runFor({
      runId: E2E_ORCHESTRATOR_RUN_IDS.succeeded,
      issue: E2E_ITEM_NUMBERS.reviewRequested,
      pipeline: 'claude',
      state: 'finished',
      createdAt: minutesAgo(70),
      updatedAt: timestamps.succeeded,
      result: true,
    }),
    runFor({
      runId: E2E_ORCHESTRATOR_RUN_IDS.failed,
      issue: E2E_ITEM_NUMBERS.humanNeeded,
      pipeline: 'claude',
      state: 'finished',
      createdAt: minutesAgo(95),
      updatedAt: timestamps.failed,
      result: false,
    }),
    runFor({
      runId: E2E_ORCHESTRATOR_RUN_IDS.timedOut,
      issue: E2E_ITEM_NUMBERS.readyForAgent,
      pipeline: 'claude',
      state: 'canceled',
      createdAt: minutesAgo(210),
      updatedAt: timestamps.timedOut,
    }),
    runFor({
      runId: E2E_ORCHESTRATOR_RUN_IDS.silentError,
      issue: E2E_ITEM_NUMBERS.silentError,
      pipeline: 'claude',
      state: 'finished',
      createdAt: minutesAgo(56),
      updatedAt: timestamps.silentError,
      result: true,
    }),
    runFor({
      runId: E2E_ORCHESTRATOR_RUN_IDS.opencodeSucceeded,
      issue: 9007,
      pipeline: 'opencode',
      state: 'finished',
      createdAt: minutesAgo(150),
      updatedAt: timestamps.opencodeSucceeded,
      result: true,
    }),
    runFor({
      runId: E2E_ORCHESTRATOR_RUN_IDS.olderSucceeded,
      issue: E2E_ITEM_NUMBERS.reviewRequested,
      pipeline: 'claude',
      state: 'finished',
      createdAt: minutesAgo(180),
      updatedAt: timestamps.olderSucceeded,
      result: true,
    }),
    runFor({
      runId: E2E_ORCHESTRATOR_RUN_IDS.olderFailed,
      issue: E2E_ITEM_NUMBERS.humanNeeded,
      pipeline: 'opencode',
      state: 'finished',
      createdAt: minutesAgo(195),
      updatedAt: timestamps.olderFailed,
      result: false,
    }),
  ];
  const tasks = [
    taskFor({
      issue: E2E_ITEM_NUMBERS.duplicateDispatch,
      title: 'feat(console): repo filter chips',
      pipeline: 'claude',
      runCount: 2,
      activeRunId: E2E_ORCHESTRATOR_RUN_IDS.running,
      updatedAt: timestamps.runningUpdated,
    }),
    taskFor({
      issue: 9009,
      title: 'chore(deps): bump the runner base image',
      pipeline: 'claude',
      runCount: 1,
      activeRunId: E2E_ORCHESTRATOR_RUN_IDS.queuedWaiting,
      updatedAt: timestamps.queuedWaiting,
    }),
    taskFor({
      issue: E2E_ITEM_NUMBERS.reviewRequested,
      title: 'feat(console): tap-icon refresh on the queue header',
      pipeline: 'claude',
      runCount: 2,
      updatedAt: timestamps.succeeded,
    }),
    taskFor({
      issue: E2E_ITEM_NUMBERS.humanNeeded,
      title: 'Decide the retention window for archived agent transcripts',
      pipeline: 'claude',
      runCount: 2,
      updatedAt: timestamps.failed,
    }),
    taskFor({
      issue: E2E_ITEM_NUMBERS.readyForAgent,
      title: 'feat(autoscaler): drain idle scale sets',
      pipeline: 'claude',
      runCount: 1,
      updatedAt: timestamps.timedOut,
    }),
    taskFor({
      issue: E2E_ITEM_NUMBERS.silentError,
      title: 'chore(telemetry): prune expired session docs',
      pipeline: 'claude',
      runCount: 1,
      updatedAt: timestamps.silentError,
    }),
    taskFor({
      issue: 9007,
      title: 'docs: refresh the onboarding runbook',
      pipeline: 'opencode',
      runCount: 1,
      updatedAt: timestamps.opencodeSucceeded,
    }),
  ];
  return { tasks, runs };
}

async function deleteCollection(firestore: Firestore, suffix: string) {
  const snapshot = await firestore
    .collection(`${COLLECTION_PREFIX}${suffix}`)
    .get();
  await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
}

/** Clears all broker fixture state in the hermetic emulator, including dynamic
 * E2E action runs whose ids are intentionally not known to this module. */
export async function resetE2eOrchestratorFixtures(): Promise<void> {
  const firestore = fixtureFirestore();
  await Promise.all(
    COLLECTIONS.map((suffix) => deleteCollection(firestore, suffix)),
  );
}

export async function seedPopulatedE2eOrchestratorFixtures(): Promise<void> {
  const firestore = fixtureFirestore();
  const { tasks, runs } = populatedFixture();
  const batch = firestore.batch();
  for (const task of tasks) {
    batch.set(
      firestore
        .collection(`${COLLECTION_PREFIX}tasks`)
        .doc(encodeURIComponent(taskKey(task.task))),
      {
        task,
        revision: 1,
      },
    );
  }
  for (const run of runs) {
    batch.set(
      firestore
        .collection(`${COLLECTION_PREFIX}runs`)
        .doc(encodeURIComponent(run.runId)),
      run,
    );
  }
  await batch.commit();
}
