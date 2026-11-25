import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type HookSessionState,
  hookSessionStateDirectory,
  writeHookSessionState,
} from '../hook/hook-state';
import { type DeliveredStore, fileDeliveredStore } from './delivered-store';
import { DeliveryMetrics } from './metrics';
import {
  IDLE_MIN_INTERVAL_MS,
  IDLE_SETTLE_MS,
  listRecentHookSessions,
  REPORT_MAX_ATTEMPTS,
  SESSION_LOOKBACK_MS,
  SESSION_REPORT_TICK_MS,
  SessionReporter,
} from './session-reporter';
import type { ForwardResult, SessionReportResult } from './subscribe-forwarder';
import type { TargetCheck } from './terminal-target';

const T0 = Date.parse('2026-11-25T12:00:00.000Z');

function state(
  sessionId: string,
  overrides: Partial<HookSessionState> = {},
): HookSessionState {
  return {
    version: 1,
    sessionId,
    seq: 1,
    lastKind: 'prompt',
    herdrPaneId: 't1',
    herdrForeground: { pid: 100, start: 'boot/1' },
    updatedAt: '2026-11-25T11:59:00.000Z',
    ...overrides,
  };
}

const ready: TargetCheck = { kind: 'ready', address: 't1', turn: 1 };
const busy: TargetCheck = {
  kind: 'busy',
  address: 't1',
  turn: 1,
  status: 'working',
};

function memoryStore(): DeliveredStore & { ids: Map<string, number> } {
  const ids = new Map<string, number>();
  return {
    ids,
    has: (id) => ids.has(id),
    record: (id, at) => ids.set(id, at),
  };
}

function harness(
  options: {
    reported?: DeliveredStore;
    answer?: () => ForwardResult<SessionReportResult>;
  } = {},
) {
  let now = T0;
  let sessions: HookSessionState[] = [];
  let check: TargetCheck = busy;
  const metrics = new DeliveryMetrics();
  const report = vi.fn(
    async (
      _sessionId: string,
      _kind: 'idle' | 'ended',
      _occurredAt: string,
    ): Promise<ForwardResult<SessionReportResult>> =>
      options.answer?.() ?? {
        ok: true,
        value: { eventId: 'e', delivered: 1 },
      },
  );
  const checkTarget = vi.fn(async () => check);
  const reported = options.reported ?? memoryStore();
  const reporter = new SessionReporter({
    listSessions: () => sessions,
    checkTarget,
    report,
    reported,
    metrics,
    log: () => undefined,
    now: () => now,
  });
  return {
    reporter,
    report,
    checkTarget,
    metrics,
    reported,
    set: (next: { sessions?: HookSessionState[]; check?: TargetCheck }) => {
      if (next.sessions) sessions = next.sessions;
      if (next.check) check = next.check;
    },
    advance: (ms: number) => {
      now += ms;
    },
    /** One tick after `ms`. */
    tick: async (ms = SESSION_REPORT_TICK_MS) => {
      now += ms;
      await reporter.tick();
    },
    calls: () =>
      report.mock.calls.map(([id, kind, at]) => `${kind} ${id} ${at}`),
  };
}

const metric = (metrics: DeliveryMetrics, kind: string, outcome: string) =>
  metrics.sessionReports.get(`${kind}\u0000${outcome}`);

describe('SessionReporter: ended', () => {
  it('reports a recorded end once, with the time it was recorded', async () => {
    const h = harness();
    h.set({
      sessions: [
        state('s1', { lastKind: 'end', updatedAt: '2026-11-25T11:58:00Z' }),
      ],
    });
    await h.tick();
    await h.tick();
    expect(h.calls()).toEqual(['ended s1 2026-11-25T11:58:00.000Z']);
    expect(h.reported.has('ended:s1')).toBe(true);
    expect(metric(h.metrics, 'ended', 'reported')).toBe(1);
    // A session with no terminal is still reported ended.
    expect(h.checkTarget).not.toHaveBeenCalled();
  });

  it('does not report an end again after a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-reports-'));
    try {
      const ended = [state('s1', { lastKind: 'end' })];
      const first = harness({ reported: fileDeliveredStore(dir, () => T0) });
      first.set({ sessions: ended });
      await first.tick();
      const second = harness({ reported: fileDeliveredStore(dir, () => T0) });
      second.set({ sessions: ended });
      await second.tick();
      expect(first.report).toHaveBeenCalledTimes(1);
      expect(second.report).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not retry a report LCARS refuses', async () => {
    const h = harness({
      answer: () => ({
        ok: false,
        error: 'forbidden',
        message: 'not this host',
        retryable: false,
      }),
    });
    h.set({ sessions: [state('s1', { lastKind: 'end' })] });
    await h.tick();
    await h.tick(REPORT_MAX_ATTEMPTS * 60_000);
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(metric(h.metrics, 'ended', 'rejected')).toBe(1);
  });

  it('retries with backoff, then reports', async () => {
    let failures = 2;
    const h = harness({
      answer: () =>
        failures-- > 0
          ? {
              ok: false,
              error: 'unavailable',
              message: 'down',
              retryable: true,
            }
          : { ok: true, value: { eventId: 'e', delivered: 0 } },
    });
    h.set({ sessions: [state('s1', { lastKind: 'end' })] });
    await h.tick(); // fails; next try in 5 s
    await h.tick(1_000); // not due yet
    expect(h.report).toHaveBeenCalledTimes(1);
    await h.tick(5_000); // fails; next try in 10 s
    await h.tick(5_000);
    expect(h.report).toHaveBeenCalledTimes(2);
    await h.tick(5_000);
    expect(h.report).toHaveBeenCalledTimes(3);
    expect(metric(h.metrics, 'ended', 'retried')).toBe(2);
    expect(metric(h.metrics, 'ended', 'reported')).toBe(1);
    // Every attempt carries the same event time, so the event id is stable.
    expect(new Set(h.report.mock.calls.map((call) => call[2])).size).toBe(1);
  });

  it('gives up after its attempts and does not start over', async () => {
    const h = harness({
      answer: () => ({
        ok: false,
        error: 'unavailable',
        message: 'down',
        retryable: true,
      }),
    });
    h.set({ sessions: [state('s1', { lastKind: 'end' })] });
    for (let i = 0; i < REPORT_MAX_ATTEMPTS + 4; i += 1) await h.tick(600_000);
    expect(h.report).toHaveBeenCalledTimes(REPORT_MAX_ATTEMPTS);
    expect(metric(h.metrics, 'ended', 'failed')).toBe(1);
    expect(h.reported.has('ended:s1')).toBe(false);
  });

  it('skips a session id LCARS would refuse', async () => {
    const h = harness();
    h.set({ sessions: [state('../bad', { lastKind: 'end' })] });
    await h.tick();
    expect(h.report).not.toHaveBeenCalled();
  });
});

describe('SessionReporter: idle', () => {
  it('reports a session that went from working to its prompt and stayed', async () => {
    const h = harness();
    h.set({ sessions: [state('s1')], check: busy });
    await h.tick(); // baseline: working
    h.set({ check: ready });
    await h.tick(); // at its prompt: settling
    expect(h.report).not.toHaveBeenCalled();
    await h.tick(IDLE_SETTLE_MS);
    expect(h.calls()).toEqual([
      `idle s1 ${new Date(T0 + 2 * SESSION_REPORT_TICK_MS).toISOString()}`,
    ]);
    await h.tick();
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(metric(h.metrics, 'idle', 'reported')).toBe(1);
  });

  it('does not report a prompt that lasts less than the settle time', async () => {
    const h = harness();
    h.set({ sessions: [state('s1')], check: busy });
    await h.tick();
    h.set({ check: ready });
    await h.tick();
    h.set({ check: busy });
    await h.tick();
    h.set({ check: ready });
    await h.tick();
    expect(h.report).not.toHaveBeenCalled();
  });

  it('never reports the first look, even at the prompt', async () => {
    const h = harness();
    h.set({ sessions: [state('s1', { lastKind: 'stop' })], check: ready });
    await h.tick();
    await h.tick();
    await h.tick();
    expect(h.report).not.toHaveBeenCalled();
  });

  it('catches a turn that started and stopped between two looks', async () => {
    const h = harness();
    h.set({
      sessions: [state('s1', { seq: 3, lastKind: 'stop' })],
      check: ready,
    });
    await h.tick();
    h.set({ sessions: [state('s1', { seq: 7, lastKind: 'stop' })] });
    await h.tick();
    await h.tick(IDLE_SETTLE_MS);
    expect(h.report).toHaveBeenCalledTimes(1);
  });

  it('reports idle at most once per window, then the latest if still idle', async () => {
    const h = harness();
    h.set({ sessions: [state('s1')], check: busy });
    await h.tick();
    h.set({ check: ready });
    await h.tick();
    await h.tick();
    expect(h.report).toHaveBeenCalledTimes(1);
    // Another turn a minute later.
    h.set({ check: busy });
    await h.tick(60_000);
    h.set({ check: ready });
    await h.tick();
    await h.tick();
    await h.tick();
    expect(h.report).toHaveBeenCalledTimes(1);
    // Once the window has passed, the session is still idle: report it.
    await h.tick(IDLE_MIN_INTERVAL_MS);
    expect(h.report).toHaveBeenCalledTimes(2);
  });

  it('ignores a session outside herdr-core and forgets one whose terminal is gone', async () => {
    const h = harness();
    h.set({
      sessions: [
        state('s1', { herdrPaneId: undefined, herdrForeground: undefined }),
      ],
    });
    await h.tick();
    expect(h.checkTarget).not.toHaveBeenCalled();

    h.set({ sessions: [state('s2')], check: busy });
    await h.tick();
    h.set({ check: { kind: 'gone', reason: 'terminal-gone' } });
    await h.tick();
    // Starts over from a fresh baseline: ready is not a transition.
    h.set({ check: ready });
    await h.tick();
    await h.tick();
    expect(h.report).not.toHaveBeenCalled();
  });

  it('keeps its baseline while herdr-core does not answer', async () => {
    const h = harness();
    h.set({ sessions: [state('s1')], check: busy });
    await h.tick();
    h.set({ check: { kind: 'unavailable' } });
    await h.tick();
    h.set({ check: ready });
    await h.tick();
    await h.tick();
    expect(h.report).toHaveBeenCalledTimes(1);
  });

  it('runs one tick at a time', async () => {
    const h = harness();
    let release: () => void = () => undefined;
    h.checkTarget.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(busy);
        }),
    );
    h.set({ sessions: [state('s1')] });
    const first = h.reporter.tick();
    await h.reporter.tick();
    release();
    await first;
    expect(h.checkTarget).toHaveBeenCalledTimes(1);
  });
});

describe('listRecentHookSessions', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads recent hook states, newest first, and skips old or foreign files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-hook-'));
    dirs.push(dir);
    writeHookSessionState(dir, state('new'));
    writeHookSessionState(dir, state('older'));
    writeHookSessionState(dir, state('stale'));
    const sessions = hookSessionStateDirectory(dir);
    const now = Date.now();
    fs.utimesSync(
      path.join(sessions, 'older.json'),
      new Date(now - 60_000),
      new Date(now - 60_000),
    );
    const old = new Date(now - SESSION_LOOKBACK_MS - 60_000);
    fs.utimesSync(path.join(sessions, 'stale.json'), old, old);
    fs.writeFileSync(path.join(sessions, 'garbage.json'), 'not json');
    fs.writeFileSync(path.join(sessions, 'new.lock'), '');
    expect(listRecentHookSessions(dir, now).map((s) => s.sessionId)).toEqual([
      'new',
      'older',
    ]);
    expect(listRecentHookSessions(path.join(dir, 'missing'), now)).toEqual([]);
  });
});

describe('session report metrics', () => {
  it('exposes every kind and outcome from the start', () => {
    const metrics = new DeliveryMetrics();
    metrics.countSessionReport('ended', 'reported');
    const text = metrics.render();
    expect(text).toContain(
      'lcars_events_agent_session_reports_total{kind="ended",outcome="reported"} 1',
    );
    expect(text).toContain(
      'lcars_events_agent_session_reports_total{kind="idle",outcome="failed"} 0',
    );
  });
});
