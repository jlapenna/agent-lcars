import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), tick: vi.fn() }));
vi.mock('./repository-job-catalog', () => ({
  refreshEnabledJobCatalogs: mocks.refresh,
}));
vi.mock('./repository-jobs', () => ({
  RepositoryJobs: class {
    deps = { store: {} };
    tick = mocks.tick;
  },
}));
vi.mock('./repository-job-store', () => ({ FirestoreJobStore: class {} }));
vi.mock('@google-cloud/firestore', () => ({ Firestore: class {} }));

import type { OrchestratorRouteDeps } from './orchestrator-routes';
import { maintainRepositoryJobs } from './repository-jobs-runtime';

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it('settles work during slow refresh and retries this schedule window after freshness is restored', async () => {
  vi.stubEnv('PROJECT_ID', 'test');
  vi.stubEnv('DISPATCH_FIRESTORE_DATABASE_ID', 'test');
  let finishRefresh!: () => void;
  let fresh = false;
  const admitted = new Set<string>();
  mocks.refresh.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishRefresh = () => {
          fresh = true;
          resolve();
        };
      }),
  );
  mocks.tick.mockImplementation(async () => {
    if (fresh) admitted.add('current-schedule-slot');
    return [];
  });
  const deadline = Date.now() + 45_000;
  const pending = maintainRepositoryJobs(deadline, {} as OrchestratorRouteDeps);
  await vi.waitFor(() => expect(mocks.tick).toHaveBeenCalledTimes(1));
  expect(admitted.size).toBe(0);
  finishRefresh();
  await pending;
  expect(mocks.tick).toHaveBeenCalledTimes(2);
  expect(mocks.tick).toHaveBeenLastCalledWith(deadline);
  expect([...admitted]).toEqual(['current-schedule-slot']);
});

it('awaits refresh even when settlement fails', async () => {
  vi.stubEnv('PROJECT_ID', 'test');
  vi.stubEnv('DISPATCH_FIRESTORE_DATABASE_ID', 'test');
  let finishRefresh!: () => void;
  mocks.refresh.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishRefresh = resolve;
      }),
  );
  mocks.tick.mockRejectedValue(new Error('store unavailable'));
  let settled = false;
  const pending = maintainRepositoryJobs(
    Date.now() + 45_000,
    {} as OrchestratorRouteDeps,
  ).catch((error: unknown) => {
    settled = true;
    return error;
  });
  await vi.waitFor(() => expect(mocks.tick).toHaveBeenCalledTimes(1));
  expect(settled).toBe(false);
  finishRefresh();
  expect(await pending).toEqual(new Error('store unavailable'));
});
