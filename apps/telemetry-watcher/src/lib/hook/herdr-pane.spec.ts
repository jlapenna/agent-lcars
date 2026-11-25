import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  defaultHerdrPaneDependencies,
  herdrCoreSocketPath,
  type HerdrPaneDependencies,
  type HerdrTerminalList,
  listHerdrCoreTerminals,
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

/** Terminals in the shape herdr-core's `terminal.list` gives them. */
function listed(terminals: Terminal[]): unknown[] {
  return terminals.map(({ address, state, pid, foreground }) => ({
    address,
    state: state ?? 'live',
    pid,
    ...(foreground && { foreground: { pid: foreground, name: 'claude' } }),
  }));
}

function deps(
  terminals: Terminal[] | HerdrTerminalList,
  overrides: Partial<HerdrPaneDependencies> = {},
): HerdrPaneDependencies {
  const answer: HerdrTerminalList = Array.isArray(terminals)
    ? { ok: true, terminals: listed(terminals) }
    : terminals;
  return {
    startPid: 900,
    parentPid: (pid) => PARENTS[pid],
    listTerminals: vi.fn(async () => answer),
    ...overrides,
  };
}

describe('resolveHerdrPane', () => {
  it('finds the herdr-core terminal whose foreground process is an ancestor', async () => {
    expect(
      await resolveHerdrPane(
        deps([
          { address: 't2', pid: 111, foreground: 112 },
          { address: 't36', pid: 700, foreground: 800 },
        ]),
      ),
    ).toEqual({ status: 'found', paneId: 't36' });
  });

  it('matches the terminal shell when the agent is not the foreground process', async () => {
    expect(
      await resolveHerdrPane(
        deps([{ address: 't9', pid: 700, foreground: 4242 }]),
      ),
    ).toEqual({ status: 'found', paneId: 't9' });
  });

  it('prefers the nearest ancestor when two terminals are in the chain', async () => {
    for (const terminals of [
      [
        { address: 'outer', pid: 600 },
        { address: 'inner', pid: 800 },
      ],
      [
        { address: 'inner', pid: 800 },
        { address: 'outer', pid: 600 },
      ],
    ]) {
      expect(await resolveHerdrPane(deps(terminals))).toEqual({
        status: 'found',
        paneId: 'inner',
      });
    }
  });

  it('reports none when no terminal owns the session', async () => {
    expect(
      await resolveHerdrPane(
        deps([{ address: 't2', pid: 111, foreground: 112 }]),
      ),
    ).toEqual({ status: 'none' });
  });

  it('skips finished terminals and other machines', async () => {
    expect(
      await resolveHerdrPane(
        deps([
          { address: 't1', state: 'finished', pid: 700 },
          { address: 'laptop/t7', pid: 700 },
        ]),
      ),
    ).toEqual({ status: 'none' });
  });

  it('reports none when no core is listening on this host', async () => {
    expect(await resolveHerdrPane(deps({ ok: false, absent: true }))).toEqual({
      status: 'none',
    });
  });

  it('reports unknown when the core cannot answer, so the hook asks again', async () => {
    expect(await resolveHerdrPane(deps({ ok: false, absent: false }))).toEqual({
      status: 'unknown',
    });
    // An answer that is not a terminal list.
    expect(
      await resolveHerdrPane(deps({ ok: true, terminals: { t36: {} } })),
    ).toEqual({ status: 'unknown' });
  });

  it('ignores entries it cannot read and still finds its own', async () => {
    const terminals = [
      null,
      'not a terminal',
      { address: 7, pid: 700 },
      { address: 't3', pid: '700' },
      ...listed([{ address: 't36', pid: 700 }]),
    ];
    expect(await resolveHerdrPane(deps({ ok: true, terminals }))).toEqual({
      status: 'found',
      paneId: 't36',
    });
  });

  it('reports none without asking when it has no parent process to start from', async () => {
    const dependencies = deps([{ address: 't36', pid: 700 }], { startPid: 0 });
    expect(await resolveHerdrPane(dependencies)).toEqual({ status: 'none' });
    expect(dependencies.listTerminals).not.toHaveBeenCalled();
  });

  it('still matches its direct parent when the rest of the ancestry is unreadable', async () => {
    // No /proc: the hook knows only the process that started it.
    const blind = { parentPid: () => undefined };
    expect(
      await resolveHerdrPane(
        deps([{ address: 't36', pid: 700, foreground: 900 }], blind),
      ),
    ).toEqual({ status: 'found', paneId: 't36' });
    expect(
      await resolveHerdrPane(
        deps([{ address: 't36', pid: 700, foreground: 800 }], blind),
      ),
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

describe('herdrCoreSocketPath', () => {
  const home = '/nonexistent-home';

  it('follows herdr-core: HC_SOCKET, then the runtime directory and session', () => {
    expect(herdrCoreSocketPath({ HC_SOCKET: '/tmp/x.sock' }, home, 1000)).toBe(
      '/tmp/x.sock',
    );
    expect(
      herdrCoreSocketPath({ XDG_RUNTIME_DIR: '/run/me' }, home, 1000),
    ).toBe('/run/me/herdr-core/default.sock');
    expect(
      herdrCoreSocketPath(
        { XDG_RUNTIME_DIR: '/run/me', HC_SESSION: 'work' },
        home,
        1000,
      ),
    ).toBe('/run/me/herdr-core/work.sock');
  });

  it('never takes the classic herdr socket a terminal exports for the core', () => {
    expect(
      herdrCoreSocketPath(
        { XDG_RUNTIME_DIR: '/run/me', HERDR_SOCKET: '/tmp/herdr.sock' },
        home,
        1000,
      ),
    ).toBe('/run/me/herdr-core/default.sock');
  });

  it('refuses a session name that is not a plain name', () => {
    for (const session of ['../other', '..', 'a/b', '']) {
      expect(
        herdrCoreSocketPath(
          { XDG_RUNTIME_DIR: '/run/me', HC_SESSION: session },
          home,
          1000,
        ),
      ).toBe('/run/me/herdr-core/default.sock');
    }
  });

  it('falls back to the state directory when there is no runtime directory', () => {
    // No uid, as on a platform without one: no /run/user/<uid> to look in.
    expect(herdrCoreSocketPath({}, home, null)).toBe(
      `${home}/.local/state/herdr-core/default/default.sock`,
    );
    expect(herdrCoreSocketPath({ XDG_STATE_HOME: '/state' }, home, null)).toBe(
      '/state/herdr-core/default/default.sock',
    );
  });

  it("reads a socket from herdr-core's config, top-level keys only", () => {
    const config = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-config-'));
    try {
      fs.mkdirSync(path.join(config, 'herdr-core'));
      const file = path.join(config, 'herdr-core', 'config.toml');
      const env = { XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: '/run/me' };

      fs.writeFileSync(
        file,
        'theme = "dark"\nsocket = "/custom/core.sock" # mine\n',
      );
      expect(herdrCoreSocketPath(env, home, 1000)).toBe('/custom/core.sock');

      fs.writeFileSync(file, '[remote]\nsocket = "/not/this.sock"\n');
      expect(herdrCoreSocketPath(env, home, 1000)).toBe(
        '/run/me/herdr-core/default.sock',
      );
    } finally {
      fs.rmSync(config, { recursive: true, force: true });
    }
  });
});

describe('listHerdrCoreTerminals', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  /** A core that answers each request line with `reply(request)`. */
  async function core(
    reply: (request: Record<string, unknown>) => string | undefined,
  ): Promise<{ socketPath: string; requests: unknown[] }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-core-'));
    const socketPath = path.join(dir, 'default.sock');
    const requests: unknown[] = [];
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('error', () => undefined);
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        const request = JSON.parse(buffer.slice(0, end));
        requests.push(request);
        const answer = reply(request);
        if (answer !== undefined) socket.write(answer);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanups.push(() => {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return { socketPath, requests };
  }

  it('asks the core once, in line-delimited JSON-RPC, and returns its terminals', async () => {
    const terminals = listed([{ address: 't36', pid: 700, foreground: 800 }]);
    const { socketPath, requests } = await core(
      (request) =>
        `${JSON.stringify({ jsonrpc: '2.0', id: request['id'], result: { terminals, machines: [] } })}\n`,
    );
    expect(await listHerdrCoreTerminals(socketPath)).toEqual({
      ok: true,
      terminals,
    });
    expect(requests).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'terminal.list', params: {} },
    ]);
  });

  it('feeds the lookup end to end', async () => {
    const { socketPath } = await core(
      () =>
        `${JSON.stringify({ result: { terminals: listed([{ address: 't36', pid: 700 }]) } })}\n`,
    );
    expect(
      await resolveHerdrPane({
        startPid: 900,
        parentPid: (pid) => PARENTS[pid],
        listTerminals: () => listHerdrCoreTerminals(socketPath),
      }),
    ).toEqual({ status: 'found', paneId: 't36' });
  });

  it('says no core is here when the socket does not exist, and starts nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-core-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const socketPath = path.join(dir, 'default.sock');
    expect(await listHerdrCoreTerminals(socketPath)).toEqual({
      ok: false,
      absent: true,
    });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('does not call a socket nothing listens on absent', async () => {
    // What a core that stopped leaves behind: a path nothing accepts on.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-core-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const socketPath = path.join(dir, 'default.sock');
    fs.writeFileSync(socketPath, '');
    expect(await listHerdrCoreTerminals(socketPath)).toEqual({
      ok: false,
      absent: false,
    });
  });

  it.each([
    ['an error', '{"jsonrpc":"2.0","id":1,"error":{"code":-32601}}\n'],
    ['text that is not JSON', 'hello\n'],
    ['a result with no terminals', '{"result":{}}\n'],
  ])('reports a failure for %s', async (_name, answer) => {
    const { socketPath } = await core(() => answer);
    expect(await listHerdrCoreTerminals(socketPath)).toEqual({
      ok: false,
      absent: false,
    });
  });

  it('gives up on a core that does not answer in time', async () => {
    const { socketPath } = await core(() => undefined);
    const started = Date.now();
    expect(await listHerdrCoreTerminals(socketPath, 50)).toEqual({
      ok: false,
      absent: false,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('defaultHerdrPaneDependencies', () => {
  it('reads its own ancestry from /proc where there is one', () => {
    const { parentPid } = defaultHerdrPaneDependencies({});
    expect(parentPid(process.pid)).toBe(process.ppid);
    expect(parentPid(2 ** 30)).toBeUndefined();
  });

  it('asks the socket its environment names, and never a program', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-core-'));
    try {
      // An empty PATH: finding `herdr-core` is not what this depends on.
      const { listTerminals } = defaultHerdrPaneDependencies({
        PATH: '',
        HC_SOCKET: path.join(dir, 'none.sock'),
      });
      expect(await listTerminals()).toEqual({ ok: false, absent: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
