import type { Run, Task } from '@agent-lcars/orchestrator';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agentRunFromOrchestrator,
  getAgentActivity,
  queueFromLiveRuns,
} from './agent-activity';
import { getAutoscalerStatuses } from './autoscaler-status';
import { createOrchestratorRuntime } from './orchestrator-runtime';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');
const T0 = '2026-08-28T10:00:00.000Z';

const store = {
  listLiveRuns: vi.fn(),
  listRecentRuns: vi.fn(),
  readTask: vi.fn(),
};

vi.mock('./orchestrator-runtime', () => ({
  createOrchestratorRuntime: vi.fn(),
}));

vi.mock('./autoscaler-status', () => ({
  getAutoscalerStatuses: vi.fn(),
}));

function githubTask(issue = 42): Task {
  return {
    task: { repo: 'octo/example', issue },
    runCount: 1,
    updatedAt: T0,
    work: {
      spec: {
        title: `GitHub task ${issue}`,
        description: 'd',
        pipeline: 'claude',
        target: { repo: 'octo/example' },
      },
    },
  };
}

function nativeTask(): Task {
  return {
    task: { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' },
    runCount: 1,
    updatedAt: T0,
    work: {
      spec: {
        title: 'Native task',
        description: 'd',
        pipeline: 'opencode',
        target: { repo: 'octo/example' },
      },
    },
  };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    runId: 'octo/example#42/r1',
    task: { repo: 'octo/example', issue: 42 },
    state: 'running',
    pipeline: 'claude',
    requestId: 'request-1',
    leaseExpiresAt: '2026-08-28T14:00:00.000Z',
    events: [{ at: T0, to: 'pending', by: 'request' }],
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (createOrchestratorRuntime as ReturnType<typeof vi.fn>).mockReturnValue({
    store,
  });
  (getAutoscalerStatuses as ReturnType<typeof vi.fn>).mockResolvedValue({
    statuses: [],
    warnings: [],
  });
  store.listLiveRuns.mockResolvedValue([]);
  store.listRecentRuns.mockResolvedValue([]);
  store.readTask.mockResolvedValue(undefined);
});

describe('agentRunFromOrchestrator', () => {
  it('projects GitHub and native anchors from authoritative Task and Run records', () => {
    const github = agentRunFromOrchestrator(run(), githubTask(), NOW);
    const nativeRun = run({
      runId: 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
      task: { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' },
      state: 'pending',
      pipeline: 'opencode',
    });
    const native = agentRunFromOrchestrator(nativeRun, nativeTask(), NOW);

    expect(github).toMatchObject({
      id: 'octo/example#42/r1',
      issueNumber: 42,
      status: 'running',
      executor: 'queue',
      displayTitle: '#42: GitHub task 42',
    });
    expect(native).toMatchObject({
      id: 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
      workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
      status: 'queued',
      url: '/work/01J5Z3K9QX8F0N2B4V6C8D1E3G',
      displayTitle: 'Native task',
    });
  });
});

describe('getAgentActivity', () => {
  it('uses authoritative live and terminal Run records for every anchor while reading capacity once from autoscaler telemetry', async () => {
    const github = githubTask();
    const native = nativeTask();
    const live = run();
    const finished = run({
      runId: 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
      task: native.task,
      state: 'finished',
      pipeline: 'opencode',
      result: { ok: true, summary: 'done' },
      updatedAt: '2026-08-28T11:30:00.000Z',
    });
    store.listLiveRuns.mockResolvedValue([live]);
    store.listRecentRuns.mockResolvedValue([finished]);
    store.readTask.mockImplementation(async (task: Task['task']) =>
      'workId' in task
        ? { task: native, revision: 1 }
        : { task: github, revision: 1 },
    );
    (getAutoscalerStatuses as ReturnType<typeof vi.fn>).mockResolvedValue({
      statuses: [
        {
          schemaVersion: 1,
          scaleSet: 'linux-arm64',
          registration: 'registered',
          queuedJobs: 0,
          minRunners: 0,
          maxRunners: 2,
          draining: false,
          runners: [
            { name: 'a', host: 'laforge', state: 'busy' },
            { name: 'b', host: 'janeway', state: 'idle' },
          ],
          updatedAt: '2026-08-28T12:00:00.000Z',
        },
      ],
      warnings: [],
    });

    const activity = await getAgentActivity();

    expect(activity.liveRuns.map((entry) => entry.id)).toEqual([live.runId]);
    expect(activity.recentRuns.map((entry) => entry.id)).toEqual([
      finished.runId,
    ]);
    expect(activity.fleet).toEqual({ online: 2, busy: 1 });
    expect(activity.queue).toEqual({ queued: 0, claimed: 0, running: 1 });
    expect(store.listLiveRuns).toHaveBeenCalledTimes(1);
    expect(store.listRecentRuns).toHaveBeenCalledWith(24);
    expect(store.readTask).toHaveBeenCalledTimes(2);
  });

  it('keeps one genuine authoritative-data warning when the store read fails', async () => {
    store.listLiveRuns.mockRejectedValue(new Error('unavailable'));
    store.listRecentRuns.mockRejectedValue(new Error('unavailable'));

    const activity = await getAgentActivity();

    expect(activity.liveRuns).toEqual([]);
    expect(activity.recentRuns).toEqual([]);
    expect(activity.queue).toBeUndefined();
    expect(activity.warnings).toEqual([
      'Authoritative live run activity unavailable.',
      'Authoritative recent run activity unavailable.',
    ]);
  });

  it('bounds recent reads and never scans tasks or per-task runs', async () => {
    const native = nativeTask();
    const finished = run({
      runId: 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
      task: native.task,
      state: 'finished',
      pipeline: 'opencode',
      result: { ok: true },
    });
    store.listRecentRuns.mockResolvedValue([finished]);
    store.readTask.mockResolvedValue({ task: native, revision: 1 });

    const activity = await getAgentActivity();

    expect(activity.recentRuns.map((entry) => entry.id)).toEqual([
      finished.runId,
    ]);
    expect(store.listRecentRuns).toHaveBeenCalledWith(24);
    expect(store.readTask).toHaveBeenCalledTimes(1);
    expect(store).not.toHaveProperty('listTasks');
    expect(store).not.toHaveProperty('listRuns');
  });

  it('reads each bounded recent anchor only once when it has multiple runs', async () => {
    const github = githubTask();
    const newest = run({
      runId: 'octo/example#42/r2',
      state: 'finished',
      result: { ok: true },
      updatedAt: '2026-08-28T11:00:00.000Z',
    });
    const older = run({ state: 'finished', result: { ok: true } });
    store.listRecentRuns.mockResolvedValue([newest, older]);
    store.readTask.mockResolvedValue({ task: github, revision: 1 });

    const activity = await getAgentActivity();

    expect(activity.recentRuns.map((entry) => entry.id)).toEqual([
      newest.runId,
      older.runId,
    ]);
    expect(store.readTask).toHaveBeenCalledTimes(1);
  });
});

describe('queueFromLiveRuns', () => {
  it('derives queue, claimed, and running lifecycle counts from Run state rather than runner capacity', () => {
    expect(
      queueFromLiveRuns([
        run({ state: 'pending' }),
        run({
          runId: 'octo/example#42/r2',
          state: 'pending',
          queue: { state: 'claimed' },
        }),
        run({ runId: 'octo/example#42/r3', state: 'running' }),
      ]),
    ).toEqual({ queued: 1, claimed: 1, running: 1 });
  });
});
