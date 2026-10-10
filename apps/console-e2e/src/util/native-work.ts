import {
  FirestoreScheduleStore,
  FirestoreStore,
  Orchestrator,
  type Run,
} from '@agent-lcars/orchestrator';
import { Firestore } from '@google-cloud/firestore';

export const NATIVE_WORK_ID = '01J5Z3K9QX8F0N2B4V6C8D1E3G';
export const NATIVE_WORK_TITLE = 'Choose native decision storage';
export const WORK_ADMIN_HEADERS = {
  'X-e2e-auth-user': 'e2e-agent-lcars-admin',
};

// These helpers touch only the hermetic emulator. Never fall back to a live
// project or Application Default Credentials when a test is run incorrectly.
function emulatorOptions() {
  const host = process.env['FIRESTORE_EMULATOR_HOST'];
  const projectId = process.env['PROJECT_ID'];
  if (!host?.startsWith('127.0.0.1:') || projectId !== 'demo-no-project') {
    throw new Error('Native Work fixtures require the local demo emulator');
  }
  return {
    projectId,
    databaseId: process.env['DISPATCH_FIRESTORE_DATABASE_ID'] ?? '(default)',
  };
}

/** Resume selection is intentionally not rendered in the runs table. Read
 * the actual admitted Run to prove the browser action persisted its binding. */
export async function readNativeRuns() {
  return new FirestoreStore(emulatorOptions()).listRuns({
    workId: NATIVE_WORK_ID,
  });
}

export async function resetSchedules() {
  const firestore = new Firestore(emulatorOptions());
  try {
    const schedules = await firestore
      .collection('orchestrator-schedules')
      .get();
    await Promise.all(schedules.docs.map((doc) => doc.ref.delete()));
  } finally {
    await firestore.terminate();
  }
}

/** Seed only the scheduler-owned watermark; create/enable/disable themselves
 * always go through the real browser and Server Actions. No clock/tick or
 * extra cron grant is needed to test a Last item navigation link. */
export async function seedLastScheduleItem(scheduleId: string) {
  const store = new FirestoreScheduleStore(emulatorOptions());
  const schedule = await store.readSchedule(scheduleId);
  if (!schedule) throw new Error('Schedule fixture was not created');
  await store.writeSchedule({ ...schedule, lastItemId: NATIVE_WORK_ID });
}

/** Attach deterministic navigation evidence to an already parked fixture.
 * All writes remain inside the explicitly guarded demo emulator. */
export async function seedDetailNavigationEvidence(githubIssue?: number) {
  const options = emulatorOptions();
  const store = new FirestoreStore(options);
  const anchor =
    githubIssue === undefined
      ? { workId: NATIVE_WORK_ID }
      : { repo: 'supersprinklesracing/sprinkles', issue: githubIssue };
  const runId =
    githubIssue === undefined
      ? `work:${NATIVE_WORK_ID}/r1`
      : `supersprinklesracing/sprinkles#${githubIssue}/r1`;
  const [versioned, run] = await Promise.all([
    store.readTask(anchor),
    store.readRun(runId),
  ]);
  if (!versioned || !run?.result)
    throw new Error('Missing parked detail fixture');
  const ref = 'https://github.com/supersprinklesracing/sprinkles/pull/9420';
  await store.apply({
    expectedRevision: versioned.revision,
    decision: {
      task: versioned.task,
      run: { ...run, result: { ...run.result, ref } },
      outbox: [],
    },
  });
  const firestore = new Firestore({
    ...options,
    databaseId: process.env['AGENT_TELEMETRY_DATABASE_ID'] ?? '(default)',
  });
  const sessionId = 'e2e-native-resume-session';
  try {
    const doc = firestore.collection('sessions').doc(sessionId);
    const session = (await doc.get()).data();
    if (!session) throw new Error('Missing saved-session fixture');
    await doc.set({
      ...session,
      runId,
      intentId: runId,
      issueNumber: githubIssue ?? 0,
      title: 'Task detail audit session',
    });
  } finally {
    await firestore.terminate();
  }
  return { ref, sessionId };
}

/** Placement regression fixtures stay in the guarded hermetic store. */
export async function seedNativeExecutionPhase(
  phase:
    | 'waiting-for-placement'
    | 'bootstrapping'
    | 'provider-execution'
    | 'unavailable'
    | 'stale'
    | 'lost',
  githubIssue?: number,
) {
  const store = new FirestoreStore(emulatorOptions());
  const anchor =
    githubIssue === undefined
      ? { workId: NATIVE_WORK_ID }
      : { repo: 'supersprinklesracing/sprinkles', issue: githubIssue };
  const runId =
    githubIssue === undefined
      ? `work:${NATIVE_WORK_ID}/r1`
      : `supersprinklesracing/sprinkles#${githubIssue}/r1`;
  const [task, oldRun] = await Promise.all([
    store.readTask(anchor),
    store.readRun(runId),
  ]);
  if (!task || !oldRun) throw new Error('Missing native placement fixture');
  const now = new Date().toISOString();
  const run: Run = {
    ...oldRun,
    state: phase === 'lost' ? ('lost' as const) : ('running' as const),
    queue: {
      state: 'claimed' as const,
      claimedAt: now,
      startDeadlineAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      placement: {
        phase:
          phase === 'bootstrapping'
            ? ('bootstrapping' as const)
            : phase === 'unavailable'
              ? ('unavailable' as const)
              : ('waiting-for-placement' as const),
        reason:
          phase === 'bootstrapping'
            ? ('scheduled' as const)
            : phase === 'unavailable'
              ? ('inventory-unavailable' as const)
              : ('unschedulable' as const),
        observedAt:
          phase === 'stale'
            ? new Date(Date.now() - 181_000).toISOString()
            : now,
        jobCreatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
      ...(phase === 'provider-execution'
        ? { firstHeartbeatAt: now, providerProcessStartedAt: now }
        : {}),
    },
  };
  if (phase === 'lost') run.queue = oldRun.queue;
  delete run.result;
  await store.apply({
    expectedRevision: task.revision,
    decision: {
      task: { ...task.task, activeRunId: phase === 'lost' ? undefined : runId },
      run,
      outbox: [],
    },
  });
  return runId;
}

/** Mint the successor through the same admission owner, after the old fixture
 * is settled, to prove its execution observations are not inherited. */
export async function seedNativePlacementRetry() {
  await seedNativeExecutionPhase('lost');
  const store = new FirestoreStore(emulatorOptions());
  const taskId = { workId: NATIVE_WORK_ID };
  const task = await store.readTask(taskId);
  if (!task) throw new Error('Missing retry fixture');
  const outcome = await new Orchestrator(store, {
    now: () => new Date().toISOString(),
  }).request({
    taskId,
    requestId: 'placement-retry-evidence',
    pipeline: 'claude',
    work: task.task.work,
  });
  if ('refused' in outcome || !outcome.run)
    throw new Error('Retry fixture was not admitted');
  return outcome.run.runId;
}
