import { describe, expect, it, vi } from 'vitest';

import type { HerdrCoreAnswer } from '../hook/herdr-pane';
import type { HookSessionState } from '../hook/hook-state';
import {
  checkTerminalTarget,
  type TerminalTargetDependencies,
} from './terminal-target';

const SESSION = 'session-1';
const START = 'boot-1/12345';

function state(overrides: Partial<HookSessionState> = {}): HookSessionState {
  return {
    version: 1,
    sessionId: SESSION,
    seq: 3,
    lastKind: 'stop',
    herdrPaneId: 't36',
    herdrForeground: { pid: 800, start: START },
    herdrPaneResolved: true,
    updatedAt: '2026-11-25T12:00:00.000Z',
    ...overrides,
  };
}

function terminal(overrides: Record<string, unknown> = {}): HerdrCoreAnswer {
  return {
    ok: true,
    result: {
      address: 't36',
      state: 'live',
      turn: 4,
      foreground: { pid: 800, name: 'claude', argv: ['claude'], cwd: '/' },
      status: { app: 'claude-code', state: 'done' },
      ...overrides,
    },
  };
}

function deps(
  session: HookSessionState | undefined,
  answer: HerdrCoreAnswer,
  processStart: (pid: number) => string | undefined = () => START,
): TerminalTargetDependencies {
  return {
    readSession: vi.fn(() => session),
    getTerminal: vi.fn(async () => answer),
    processStart: vi.fn(processStart),
  };
}

describe('checkTerminalTarget', () => {
  it.each(['idle', 'done', 'error'])(
    'is ready when the terminal still runs the session, which reports %s',
    async (status) => {
      const d = deps(state(), terminal({ status: { state: status } }));
      expect(await checkTerminalTarget(d, SESSION)).toEqual({
        kind: 'ready',
        address: 't36',
        turn: 4,
      });
      expect(d.getTerminal).toHaveBeenCalledWith('t36');
      expect(d.processStart).toHaveBeenCalledWith(800);
    },
  );

  it.each(['working', 'blocked'])(
    'is busy mid-turn or on an approval prompt (%s)',
    async (status) => {
      expect(
        await checkTerminalTarget(
          deps(state(), terminal({ status: { state: status } })),
          SESSION,
        ),
      ).toEqual({ kind: 'busy', address: 't36', turn: 4, status });
    },
  );

  it.each<[string, HookSessionState | undefined, string]>([
    ['no hook state', undefined, 'unknown-session'],
    ['an ended session', state({ lastKind: 'end' }), 'session-ended'],
    [
      'no terminal',
      state({ herdrPaneId: undefined, herdrForeground: undefined }),
      'not-addressable',
    ],
    [
      'a terminal found before its process was recorded',
      state({ herdrForeground: undefined }),
      'not-addressable',
    ],
  ])('is gone for %s, without asking herdr-core', async (_name, s, reason) => {
    const d = deps(s, terminal());
    expect(await checkTerminalTarget(d, SESSION)).toEqual({
      kind: 'gone',
      reason,
    });
    expect(d.getTerminal).not.toHaveBeenCalled();
  });

  it('is gone when the terminal runs another process, even an idle one', async () => {
    // The session exited and its shell, or a new agent, took the terminal.
    expect(
      await checkTerminalTarget(
        deps(
          state(),
          terminal({ foreground: { pid: 700, name: 'bash' }, status: null }),
        ),
        SESSION,
      ),
    ).toEqual({ kind: 'gone', reason: 'foreground-changed' });
  });

  it('is gone when the PID was reused by another process', async () => {
    expect(
      await checkTerminalTarget(
        deps(state(), terminal(), () => 'boot-1/99999'),
        SESSION,
      ),
    ).toEqual({ kind: 'gone', reason: 'foreground-changed' });
  });

  it('is gone when the process start cannot be read', async () => {
    expect(
      await checkTerminalTarget(
        deps(state(), terminal(), () => undefined),
        SESSION,
      ),
    ).toEqual({ kind: 'gone', reason: 'foreground-changed' });
  });

  it('is gone when the program never reports a status', async () => {
    expect(
      await checkTerminalTarget(
        deps(state(), terminal({ status: null })),
        SESSION,
      ),
    ).toEqual({ kind: 'gone', reason: 'no-status' });
  });

  it.each<[string, HerdrCoreAnswer]>([
    ['no core', { ok: false, absent: true }],
    ['an unknown terminal', { ok: false, absent: false, error: 'not_found' }],
    ['a finished terminal', terminal({ state: 'finished', foreground: null })],
  ])('is gone for %s', async (_name, answer) => {
    expect(await checkTerminalTarget(deps(state(), answer), SESSION)).toEqual({
      kind: 'gone',
      reason: 'terminal-gone',
    });
  });

  it('is unavailable when herdr-core does not answer this time', async () => {
    expect(
      await checkTerminalTarget(
        deps(state(), { ok: false, absent: false }),
        SESSION,
      ),
    ).toEqual({ kind: 'unavailable' });
  });
});
