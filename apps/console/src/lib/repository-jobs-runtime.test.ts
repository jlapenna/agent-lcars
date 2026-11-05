import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), tick: vi.fn() }));
vi.mock('./repository-job-catalog', () => ({
  refreshJobCatalogs: mocks.refresh,
}));
vi.mock('./deployment', () => ({
  controlPlaneRepositories: () => ['octo/repo'],
  isControlPlaneRepository: (repo: string) => repo === 'octo/repo',
}));
vi.mock('./repository-jobs', () => ({
  RepositoryJobs: class {
    constructor(readonly deps: { granted: unknown }) {}
    tick = mocks.tick;
  },
}));
vi.mock('./repository-job-store', () => ({ FirestoreJobStore: class {} }));
vi.mock('@google-cloud/firestore', () => ({ Firestore: class {} }));

import type { OrchestratorRouteDeps } from './orchestrator-routes';
import {
  jobAutomationPrincipal,
  maintainRepositoryJobs,
  repositoryJobs,
} from './repository-jobs-runtime';

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

it('attributes automatic activation only to the one scheduler grant and admits no other non-operator', () => {
  vi.stubEnv('PROJECT_ID', 'test');
  vi.stubEnv('DISPATCH_FIRESTORE_DATABASE_ID', 'test');
  const grant = (
    principal: string,
    scopes: string[],
    pipelines = ['goose'],
  ) => ({
    principal,
    subjects: [principal],
    pipelines,
    scopes,
  });
  const operator = grant('user:joe', ['work.operator']);
  const scheduler = grant('svc:scheduler', ['work.executor', 'work.cron']);
  const executor = grant('svc:executor', ['work.executor']);
  vi.stubEnv(
    'AGENT_LCARS_WORK_GRANTS',
    JSON.stringify([operator, scheduler, executor]),
  );
  expect(jobAutomationPrincipal()).toBe('svc:scheduler');
  const granted = repositoryJobs({} as OrchestratorRouteDeps).deps.granted;
  expect(granted('user:joe', 'octo/repo')).toBe(true);
  expect(granted('svc:scheduler', 'octo/repo')).toBe(true);
  expect(granted('svc:executor', 'octo/repo')).toBe(false);
  // Repository admission still applies to the scheduler.
  expect(granted('svc:scheduler', 'octo/elsewhere')).toBe(false);
  // A second scheduler grant, or one without goose, disables attribution.
  vi.stubEnv(
    'AGENT_LCARS_WORK_GRANTS',
    JSON.stringify([operator, scheduler, grant('svc:cron2', ['work.cron'])]),
  );
  expect(jobAutomationPrincipal()).toBeUndefined();
  expect(granted('svc:scheduler', 'octo/repo')).toBe(false);
  vi.stubEnv(
    'AGENT_LCARS_WORK_GRANTS',
    JSON.stringify([grant('svc:scheduler', ['work.cron'], ['claude'])]),
  );
  expect(jobAutomationPrincipal()).toBeUndefined();
});
