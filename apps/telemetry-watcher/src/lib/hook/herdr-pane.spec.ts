import { describe, expect, it, vi } from 'vitest';

import {
  defaultHerdrPaneDependencies,
  type HerdrCoreResult,
  type HerdrPaneDependencies,
  parentPidFromStat,
  resolveHerdrPane,
} from './herdr-pane';

/** hook(900) <- claude(800) <- bash(700) <- herdr-core hold(600) <- init. */
const PARENTS: Record<number, number> = { 900: 800, 800: 700, 700: 600 };

interface Terminal {
  address: string;
  state?: string;
  pid?: number;
  foreground?: number;
}

function core(
  terminals: Terminal[],
  failing: readonly string[] = [],
): HerdrPaneDependencies['runCore'] {
  return vi.fn(async (args: readonly string[]): Promise<HerdrCoreResult> => {
    if (args[0] === 'ls') {
      return {
        ok: true,
        stdout: JSON.stringify({
          terminals: terminals.map(({ address, state }) => ({
            address,
            state: state ?? 'live',
          })),
        }),
      };
    }
    const found = terminals.find((terminal) => terminal.address === args[1]);
    if (!found || failing.includes(found.address)) {
      return { ok: false, missing: false };
    }
    return {
      ok: true,
      stdout: JSON.stringify({
        address: found.address,
        pid: found.pid,
        ...(found.foreground && { foreground: { pid: found.foreground } }),
      }),
    };
  });
}

function deps(
  overrides: Partial<HerdrPaneDependencies> = {},
): HerdrPaneDependencies {
  return {
    startPid: 900,
    parentPid: (pid) => PARENTS[pid],
    runCore: core([]),
    ...overrides,
  };
}

describe('resolveHerdrPane', () => {
  it('finds the herdr-core terminal whose foreground process is an ancestor', async () => {
    const runCore = core([
      { address: 't2', pid: 111, foreground: 112 },
      { address: 't36', pid: 700, foreground: 800 },
    ]);
    expect(await resolveHerdrPane(deps({ runCore }))).toEqual({
      status: 'found',
      paneId: 't36',
    });
  });

  it('matches the terminal shell when the agent is not the foreground process', async () => {
    const runCore = core([{ address: 't9', pid: 700, foreground: 4242 }]);
    expect(await resolveHerdrPane(deps({ runCore }))).toEqual({
      status: 'found',
      paneId: 't9',
    });
  });

  it('prefers the nearest ancestor when two terminals are in the chain', async () => {
    const runCore = core([
      { address: 'outer', pid: 600 },
      { address: 'inner', pid: 800 },
    ]);
    expect(await resolveHerdrPane(deps({ runCore }))).toEqual({
      status: 'found',
      paneId: 'inner',
    });
  });

  it('reports none when no terminal owns the session', async () => {
    const runCore = core([{ address: 't2', pid: 111, foreground: 112 }]);
    expect(await resolveHerdrPane(deps({ runCore }))).toEqual({
      status: 'none',
    });
  });

  it('skips finished terminals and other machines', async () => {
    const runCore = core([
      { address: 't1', state: 'finished', pid: 700 },
      { address: 'laptop/t7', pid: 700 },
    ]);
    expect(await resolveHerdrPane(deps({ runCore }))).toEqual({
      status: 'none',
    });
    expect(runCore).toHaveBeenCalledTimes(1);
  });

  it('reports none when herdr-core is not installed', async () => {
    const runCore = vi.fn(async (): Promise<HerdrCoreResult> => ({
      ok: false,
      missing: true,
    }));
    expect(await resolveHerdrPane(deps({ runCore }))).toEqual({
      status: 'none',
    });
  });

  it('reports unknown when herdr-core cannot answer, so the hook asks again', async () => {
    const down = vi.fn(async (): Promise<HerdrCoreResult> => ({
      ok: false,
      missing: false,
    }));
    expect(await resolveHerdrPane(deps({ runCore: down }))).toEqual({
      status: 'unknown',
    });

    const garbled = vi.fn(async (): Promise<HerdrCoreResult> => ({
      ok: true,
      stdout: 'not json',
    }));
    expect(await resolveHerdrPane(deps({ runCore: garbled }))).toEqual({
      status: 'unknown',
    });

    // One terminal could not be read and none of the others matched: the
    // unread one may be this session's.
    const partial = core(
      [{ address: 't2', pid: 111 }, { address: 't3' }],
      ['t3'],
    );
    expect(await resolveHerdrPane(deps({ runCore: partial }))).toEqual({
      status: 'unknown',
    });
  });

  it('still finds the terminal when an unrelated one cannot be read', async () => {
    const runCore = core(
      [
        { address: 't3', pid: 111 },
        { address: 't36', pid: 700 },
      ],
      ['t3'],
    );
    expect(await resolveHerdrPane(deps({ runCore }))).toEqual({
      status: 'found',
      paneId: 't36',
    });
  });

  it('reports none without asking when it has no parent process to start from', async () => {
    const runCore = core([{ address: 't36', pid: 700 }]);
    expect(await resolveHerdrPane(deps({ startPid: 0, runCore }))).toEqual({
      status: 'none',
    });
    expect(runCore).not.toHaveBeenCalled();
  });

  it('still matches its direct parent when the rest of the ancestry is unreadable', async () => {
    // No /proc: the hook knows only the process that started it.
    const blind = { parentPid: () => undefined };
    const direct = core([{ address: 't36', pid: 700, foreground: 900 }]);
    expect(await resolveHerdrPane(deps({ ...blind, runCore: direct }))).toEqual(
      { status: 'found', paneId: 't36' },
    );
    const wrapped = core([{ address: 't36', pid: 700, foreground: 800 }]);
    expect(
      await resolveHerdrPane(deps({ ...blind, runCore: wrapped })),
    ).toEqual({ status: 'none' });
  });
});

describe('parentPidFromStat', () => {
  it('reads the parent past a command name containing spaces and parentheses', () => {
    expect(parentPidFromStat('800 (claude) S 700 800 700 34816 ...')).toBe(700);
    expect(parentPidFromStat('800 (tmux: server (1)) S 4446 800 ...')).toBe(
      4446,
    );
  });

  it('gives nothing for a line it cannot read', () => {
    for (const stat of [
      '',
      '800 claude S 700',
      '800 (claude) S x',
      '1 (init) S 0 1',
    ]) {
      expect(parentPidFromStat(stat)).toBeUndefined();
    }
  });
});

describe('defaultHerdrPaneDependencies', () => {
  it('tells a missing program from one that failed', async () => {
    const absent = defaultHerdrPaneDependencies({}, 'lcars-no-such-program');
    expect(await absent.runCore(['ls', '--json'])).toEqual({
      ok: false,
      missing: true,
    });
    const failing = defaultHerdrPaneDependencies(
      { PATH: process.env['PATH'] },
      'false',
    );
    expect(await failing.runCore(['ls', '--json'])).toEqual({
      ok: false,
      missing: false,
    });
  });

  it('reads its own ancestry from /proc where there is one', () => {
    const { parentPid } = defaultHerdrPaneDependencies({});
    expect(parentPid(process.pid)).toBe(process.ppid);
    expect(parentPid(2 ** 30)).toBeUndefined();
  });
});
