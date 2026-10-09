import {
  FirestoreScheduleStore,
  FirestoreStore,
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
