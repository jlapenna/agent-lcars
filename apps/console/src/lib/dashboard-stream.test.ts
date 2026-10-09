import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  telemetry: vi.fn(),
  queries: [] as {
    collection: string;
    field: string;
    limit: number;
    push: () => void;
    fail: (error: Error) => void;
    stop: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock('@agent-lcars/telemetry/server', () => ({
  getAgentTelemetryReaderFirestore: mocks.telemetry,
}));
vi.mock('@agent-lcars/util-server', () => ({
  required: (name: string) => name,
}));
vi.mock('@google-cloud/firestore', () => ({
  Firestore: class {
    collection(collection: string) {
      return {
        orderBy(field: string) {
          return {
            limit(limit: number) {
              return {
                onSnapshot(push: () => void, fail: (error: Error) => void) {
                  const stop = vi.fn();
                  mocks.queries.push({
                    collection,
                    field,
                    limit,
                    push,
                    fail,
                    stop,
                  });
                  return stop;
                },
              };
            },
          };
        },
      };
    }
  },
}));
import { Firestore } from '@google-cloud/firestore';

import { subscribeDashboardChanges } from './dashboard-stream';

describe('bounded authoritative dashboard change feeds', () => {
  afterEach(() => {
    mocks.queries.length = 0;
    vi.resetAllMocks();
  });

  it('waits for every initial snapshot, emits only health/invalidation, and disposes all listeners', async () => {
    mocks.telemetry.mockResolvedValue(new Firestore());
    const signal = vi.fn();
    const stop = subscribeDashboardChanges(signal);
    await Promise.resolve();
    expect(mocks.queries).toHaveLength(5);
    for (const query of mocks.queries)
      expect(query.limit).toBeLessThanOrEqual(200);
    expect(mocks.queries[0].field).toBe('streamChangedAt');
    for (const query of mocks.queries.slice(0, 4)) query.push();
    expect(signal).not.toHaveBeenCalled();
    mocks.queries[4].push();
    expect(signal).toHaveBeenLastCalledWith({ state: 'live', changed: true });
    mocks.queries[2].fail(new Error('store unavailable'));
    expect(signal).toHaveBeenLastCalledWith({
      state: 'degraded',
      changed: true,
    });
    stop();
    stop();
    for (const query of mocks.queries)
      expect(query.stop).toHaveBeenCalledOnce();
    signal.mockClear();
    for (const query of mocks.queries) query.push();
    expect(signal).not.toHaveBeenCalled();
  });

  it('can dispose immediately while telemetry setup is pending, without late listeners', async () => {
    let resolve = (_firestore: Firestore) => undefined as void;
    mocks.telemetry.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const signal = vi.fn();
    const stop = subscribeDashboardChanges(signal);
    stop();
    for (const query of mocks.queries)
      expect(query.stop).toHaveBeenCalledOnce();
    resolve(new Firestore());
    await Promise.resolve();
    expect(mocks.queries).toHaveLength(3);
    expect(signal).not.toHaveBeenCalled();
  });

  it('reports unavailable and releases the broker listeners if telemetry cannot initialize', async () => {
    mocks.telemetry.mockRejectedValue(new Error('denied'));
    const signal = vi.fn();
    const stop = subscribeDashboardChanges(signal);
    await Promise.resolve();
    await Promise.resolve();
    expect(signal).toHaveBeenLastCalledWith({
      state: 'degraded',
      changed: false,
    });
    for (const query of mocks.queries)
      expect(query.stop).toHaveBeenCalledOnce();
    stop();
    for (const query of mocks.queries)
      expect(query.stop).toHaveBeenCalledOnce();
  });
});
