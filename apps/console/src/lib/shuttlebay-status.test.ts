import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  get: vi.fn(),
  subscribe: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('./orchestrator-runtime', () => ({
  createOrchestratorRuntime: () => ({
    store: { readQueueAdmissionStatus: mocks.read },
  }),
}));
vi.mock('./autoscaler-status', () => ({
  getAutoscalerStatuses: mocks.get,
  subscribeAutoscalerStatuses: mocks.subscribe,
}));

import {
  getShuttlebayStatus,
  subscribeShuttlebayStatus,
  withProviderAdmission,
} from './shuttlebay-status';

const admission = {
  observedAt: '2026-10-09T23:00:00.000Z',
  provenance: 'orchestrator',
  providers: [
    { pipeline: 'claude', queued: 3, deferred: 1, eligible: 2, liveClaims: 0 },
  ],
};
const telemetry = { warnings: [] };

describe('Shuttlebay provider evidence', () => {
  beforeEach(() => {
    mocks.read.mockResolvedValue(admission);
    mocks.get.mockResolvedValue(telemetry);
    mocks.subscribe.mockResolvedValue(mocks.stop);
  });
  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  it('enriches the first paint using the server-owned provider set', async () => {
    expect(await getShuttlebayStatus()).toEqual({
      ...telemetry,
      providerAdmission: admission,
    });
    expect(mocks.read).toHaveBeenCalledWith({
      pipelines: ['claude', 'codex', 'opencode'],
      now: expect.any(String),
    });
  });

  it('preserves telemetry on a failed admission read and exposes no invented counts', async () => {
    mocks.read.mockRejectedValue(new Error('offline'));
    const result = await withProviderAdmission({
      ...telemetry,
      warnings: ['Telemetry stale'],
    });
    expect(result.providerAdmission).toBeUndefined();
    expect(result.warnings).toEqual([
      'Telemetry stale',
      'Provider queue and cooldown status unavailable.',
    ]);
  });

  it('preserves successful durable evidence even when host telemetry is unavailable', async () => {
    const result = await withProviderAdmission({
      ...telemetry,
      warnings: ['Host unavailable'],
    });
    expect(result.providerAdmission).toEqual(admission);
    expect(result.warnings).toEqual(['Host unavailable']);
  });

  it('bounds responses while sharing a hung underlying admission read across retries', async () => {
    vi.useFakeTimers();
    let finish: ((value: typeof admission) => void) | undefined;
    mocks.read.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = withProviderAdmission(telemetry);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await first).providerAdmission).toBeUndefined();
    const second = withProviderAdmission(telemetry);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await second).providerAdmission).toBeUndefined();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    if (finish === undefined) throw new Error('missing pending read');
    finish(admission);
    await Promise.resolve();
    expect((await withProviderAdmission(telemetry)).providerAdmission).toEqual(
      admission,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts sources concurrently and returns durable evidence when telemetry hangs', async () => {
    vi.useFakeTimers();
    let finish: ((value: typeof telemetry) => void) | undefined;
    mocks.get.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const result = getShuttlebayStatus();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toMatchObject({
      providerAdmission: admission,
      warnings: [expect.stringContaining('telemetry read timed out')],
    });
    if (finish === undefined) throw new Error('missing pending read');
    finish(telemetry);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('streams telemetry independently of slow admission and cleans up late completion', async () => {
    vi.useFakeTimers();
    let push: ((result: typeof telemetry) => void) | undefined;
    let settle: ((value: typeof admission) => void) | undefined;
    mocks.subscribe.mockImplementation(async (callback) => {
      push = callback;
      return mocks.stop;
    });
    mocks.read.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const output = vi.fn();
    const stop = await subscribeShuttlebayStatus(output);
    if (push === undefined || settle === undefined)
      throw new Error('missing listener/read');
    push({ warnings: ['First producer snapshot'] });
    push({ warnings: ['Newest producer snapshot'] });
    expect(output).toHaveBeenCalledTimes(2);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    settle(admission);
    await vi.waitFor(() => expect(output).toHaveBeenCalledTimes(3));
    expect(output).toHaveBeenLastCalledWith({
      warnings: ['Newest producer snapshot'],
      providerAdmission: admission,
    });
    let finish: ((value: typeof admission) => void) | undefined;
    mocks.read.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    push(telemetry);
    stop();
    expect(mocks.stop).toHaveBeenCalledOnce();
    if (finish === undefined) throw new Error('missing pending read');
    finish(admission);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
    expect(output).toHaveBeenCalledTimes(4);
  });
});
