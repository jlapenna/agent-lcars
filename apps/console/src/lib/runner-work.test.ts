import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readRun: vi.fn(),
  readTask: vi.fn(),
  project: vi.fn(),
}));
vi.mock('./orchestrator-runtime', () => ({
  createOrchestratorRuntime: () => ({
    store: { readRun: mocks.readRun, readTask: mocks.readTask },
  }),
}));
vi.mock('./agent-activity', () => ({
  agentRunFromOrchestrator: mocks.project,
}));

import type { AutoscalerStatusResult } from './autoscaler-status';
import {
  resetRunnerWork,
  resolveRunnerWork,
  runnerWorkFor,
  withRunnerWork,
} from './runner-work';

const repo = { owner: 'jlapenna', name: 'agent-lcars' };

function status(runId: string): AutoscalerStatusResult {
  return {
    warnings: [],
    hostInventory: {
      hosts: [],
      runners: [
        {
          name: `lcars-${runId}`,
          kind: 'direct',
          lane: 'direct',
          state: 'busy',
          since: '2026-10-14T07:00:00Z',
          requestedCpuMillis: 2_000,
          requestedMemoryBytes: 4 * 1024 ** 3,
          runId,
        },
      ],
      updatedAt: '2026-10-14T07:00:00Z',
    },
  };
}

describe('runner work', () => {
  afterEach(() => {
    resetRunnerWork();
    vi.resetAllMocks();
  });

  it('references an issue run by its task and a Work run by its page', () => {
    expect(
      runnerWorkFor({ repo, pipeline: 'claude', issueNumber: 2479 } as never),
    ).toEqual({
      label: 'agent-lcars#2479',
      href: '/task/jlapenna/agent-lcars/2479',
      repo: 'jlapenna/agent-lcars',
      pipeline: 'claude',
    });
    expect(
      runnerWorkFor({ repo, pipeline: 'codex', workId: 'w-1' } as never),
    ).toMatchObject({ label: 'agent-lcars work', href: '/work/w-1' });
  });

  it('resolves each run once and attaches it to its row', async () => {
    mocks.readRun.mockResolvedValue({ task: 'task-1' });
    mocks.readTask.mockResolvedValue({ task: {} });
    mocks.project.mockReturnValue({ repo, pipeline: 'claude', issueNumber: 7 });
    expect(
      withRunnerWork(status('run-1')).hostInventory?.runners?.[0]?.work,
    ).toBeUndefined();
    expect(await resolveRunnerWork(status('run-1'))).toBe(true);
    expect(await resolveRunnerWork(status('run-1'))).toBe(false);
    expect(mocks.readRun).toHaveBeenCalledTimes(1);
    expect(
      withRunnerWork(status('run-1')).hostInventory?.runners?.[0]?.work?.label,
    ).toBe('agent-lcars#7');
  });

  it('shares a read in flight between callers', async () => {
    mocks.readRun.mockResolvedValue({ task: 'task-1' });
    mocks.readTask.mockResolvedValue({ task: {} });
    mocks.project.mockReturnValue({ repo, pipeline: 'claude', issueNumber: 7 });
    expect(
      await Promise.all([
        resolveRunnerWork(status('run-3')),
        resolveRunnerWork(status('run-3')),
      ]),
    ).toEqual([true, true]);
    expect(mocks.readRun).toHaveBeenCalledTimes(1);
  });

  it('leaves a run that cannot be read naming its run id, retrying after a minute', async () => {
    const now = Date.parse('2026-10-14T07:00:00Z');
    mocks.readRun.mockRejectedValue(new Error('offline'));
    expect(await resolveRunnerWork(status('run-2'), now)).toBe(false);
    expect(await resolveRunnerWork(status('run-2'), now + 1_000)).toBe(false);
    expect(mocks.readRun).toHaveBeenCalledTimes(1);
    mocks.readRun.mockResolvedValue(undefined);
    expect(await resolveRunnerWork(status('run-2'), now + 60_000)).toBe(false);
    expect(mocks.readRun).toHaveBeenCalledTimes(2);
    expect(
      withRunnerWork(status('run-2')).hostInventory?.runners?.[0]?.work,
    ).toBeUndefined();
  });
});
