import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { isHerdrPaneId } from '@agent-lcars/telemetry';

/**
 * Which herdr-core terminal a session runs in.
 *
 * - `found`: the session's own terminal, by the address herdr-core gives it.
 * - `none`: the session is not in a herdr-core terminal. Definite: do not
 *   ask again for this session until it starts again.
 * - `unknown`: herdr-core could not be asked this time. Keep whatever was
 *   known before and ask again later.
 */
export type HerdrPaneLookup =
  | { readonly status: 'found'; readonly paneId: string }
  | { readonly status: 'none' }
  | { readonly status: 'unknown' };

/**
 * herdr-core's answer to `terminal.list`.
 *
 * `absent` means no core is listening here, which is definite: its socket
 * is not there. Any other failure (a refused or slow connection, an answer
 * that is not one) is not.
 */
export type HerdrTerminalList =
  | { readonly ok: true; readonly terminals: unknown }
  | { readonly ok: false; readonly absent: boolean };

export interface HerdrPaneDependencies {
  /** The hook's own parent: the first process that may own a terminal. */
  readonly startPid: number;
  /** The parent of `pid`, or `undefined` when it cannot be read. */
  readonly parentPid: (pid: number) => number | undefined;
  /** Asks the core for its terminals, without ever starting one. */
  readonly listTerminals: () => Promise<HerdrTerminalList>;
}

/** A terminal's shell can sit several wrappers above the hook process. */
const MAX_ANCESTORS = 16;
const CORE_TIMEOUT_MS = 1_000;
/** Far more than a terminal list is; bounds what a misbehaving peer sends. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positivePid(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 1
    ? value
    : undefined;
}

function ancestorsOf(deps: HerdrPaneDependencies): number[] {
  const chain: number[] = [];
  let pid = positivePid(deps.startPid);
  while (pid !== undefined && chain.length < MAX_ANCESTORS) {
    chain.push(pid);
    pid = positivePid(deps.parentPid(pid));
  }
  return chain;
}

/**
 * Finds the herdr-core terminal the calling hook runs in.
 *
 * A herdr-core terminal exports no identity of its own, and `herdr-core get`
 * with no target cannot resolve itself from a hook, which has no terminal.
 * So the hook asks the core for its live terminals and matches each one's
 * shell and foreground process against its own ancestors. An exported
 * `HERDR_PANE_ID` is deliberately not trusted: any process started under a
 * pane inherits it, including a tmux server whose windows are later attached
 * somewhere else.
 *
 * Another machine's terminal is never returned: `isHerdrPaneId` refuses a
 * `machine/t7` address, and such a terminal's processes are not ancestors of
 * a hook on this host.
 */
export async function resolveHerdrPane(
  deps: HerdrPaneDependencies,
): Promise<HerdrPaneLookup> {
  const ancestors = ancestorsOf(deps);
  if (ancestors.length === 0) return { status: 'none' };

  const listed = await deps.listTerminals();
  if (!listed.ok) return { status: listed.absent ? 'none' : 'unknown' };
  if (!Array.isArray(listed.terminals)) return { status: 'unknown' };

  // The nearest ancestor wins, so a terminal started from inside another
  // one is never mistaken for its parent.
  let nearest: { address: string; depth: number } | undefined;
  for (const entry of listed.terminals) {
    const terminal = asRecord(entry);
    const address = terminal?.['address'];
    if (
      !terminal ||
      typeof address !== 'string' ||
      !isHerdrPaneId(address) ||
      (terminal['state'] !== undefined && terminal['state'] !== 'live')
    ) {
      continue;
    }
    const pids = [
      positivePid(terminal['pid']),
      positivePid(asRecord(terminal['foreground'])?.['pid']),
    ];
    const depth = ancestors.findIndex((ancestor) => pids.includes(ancestor));
    if (depth >= 0 && (!nearest || depth < nearest.depth)) {
      nearest = { address, depth };
    }
  }
  return nearest
    ? { status: 'found', paneId: nearest.address }
    : { status: 'none' };
}

/** The parent PID in one `/proc/<pid>/stat` line, or `undefined`. */
export function parentPidFromStat(stat: string): number | undefined {
  // The command name is parenthesized and may itself contain `)` or spaces;
  // the fields after its last `)` are `state ppid ...`.
  const close = stat.lastIndexOf(')');
  if (close < 0) return undefined;
  const parent = Number(stat.slice(close + 2).split(' ')[1]);
  return Number.isSafeInteger(parent) && parent > 0 ? parent : undefined;
}

/** Reads a parent PID from `/proc`. Linux only; anywhere else it is unknown. */
function procParentPid(pid: number): number | undefined {
  try {
    return parentPidFromStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return undefined;
  }
}

/** A top-level `socket = "..."` in herdr-core's config.toml, when it sets one. */
function configuredSocket(configPath: string): string | undefined {
  let text: string;
  try {
    const stat = fs.statSync(configPath);
    if (!stat.isFile() || stat.size > 256 * 1024) return undefined;
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) return undefined; // past the top-level keys
    const match = /^\s*socket\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(
      line,
    );
    const socket = match?.[1] ?? match?.[2];
    if (socket) return socket;
  }
  return undefined;
}

function isDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where this environment's core listens, as herdr-core works it out:
 * `HC_SOCKET`, else `socket` in its config.toml, else `<session>.sock` in
 * `herdr-core` under the runtime directory (`XDG_RUNTIME_DIR`, else
 * `/run/user/<uid>`), else beside its state. The session is `HC_SESSION`,
 * else `default`. `HERDR_SOCKET`, which a terminal does export, belongs to
 * the classic herdr server and is not this.
 */
export function herdrCoreSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = env['HOME'] || os.homedir(),
  uid: number | null = process.getuid?.() ?? null,
): string {
  if (env['HC_SOCKET']) return env['HC_SOCKET'];
  const configured = configuredSocket(
    path.join(
      env['XDG_CONFIG_HOME'] || path.join(home, '.config'),
      'herdr-core',
      'config.toml',
    ),
  );
  if (configured) return configured;

  const named = env['HC_SESSION']?.trim();
  const session =
    named && /^[A-Za-z0-9_.-]{1,64}$/.test(named) && !/^\.\.?$/.test(named)
      ? named
      : 'default';
  const userRuntime = uid === null ? undefined : `/run/user/${uid}`;
  const runtime =
    env['XDG_RUNTIME_DIR'] ||
    (userRuntime && isDirectory(userRuntime) ? userRuntime : undefined);
  if (runtime) return path.join(runtime, 'herdr-core', `${session}.sock`);
  return path.join(
    env['XDG_STATE_HOME'] || path.join(home, '.local', 'state'),
    'herdr-core',
    session,
    `${session}.sock`,
  );
}

/**
 * One `terminal.list` call on the core's own socket.
 *
 * The hook connects to the socket itself and never runs the `herdr-core`
 * program: every one of its commands but `--version` starts a core when none
 * is running, which would leave a core and its systemd unit on a host that
 * does not use one, and finding the program would depend on a `PATH` a hook
 * does not reliably inherit. A connection opens in line-delimited JSON-RPC,
 * the mode herdr-core's own `hello` is sent in, and `terminal.list` answers
 * there with every terminal's shell and foreground PID.
 */
export function listHerdrCoreTerminals(
  socketPath: string,
  timeoutMs: number = CORE_TIMEOUT_MS,
): Promise<HerdrTerminalList> {
  return new Promise((resolve) => {
    let settled = false;
    let answer = '';
    const socket = net.connect(socketPath);
    const settle = (result: HerdrTerminalList) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => settle({ ok: false, absent: false }),
      timeoutMs,
    );
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'terminal.list', params: {} })}\n`,
      );
    });
    socket.on('data', (chunk: string) => {
      answer += chunk;
      const end = answer.indexOf('\n');
      if (end < 0) {
        if (answer.length > MAX_ANSWER_BYTES) {
          settle({ ok: false, absent: false });
        }
        return;
      }
      let terminals: unknown;
      try {
        terminals = asRecord(
          asRecord(JSON.parse(answer.slice(0, end)))?.['result'],
        )?.['terminals'];
      } catch {
        terminals = undefined;
      }
      settle(
        terminals === undefined
          ? { ok: false, absent: false }
          : { ok: true, terminals },
      );
    });
    // No socket file: no core has run here. A file nothing listens on
    // (ECONNREFUSED) is a core that stopped, or one starting: ask again.
    socket.on('error', (error: NodeJS.ErrnoException) => {
      settle({ ok: false, absent: error.code === 'ENOENT' });
    });
    socket.on('close', () => settle({ ok: false, absent: false }));
  });
}

export function defaultHerdrPaneDependencies(
  env: NodeJS.ProcessEnv = process.env,
): HerdrPaneDependencies {
  return {
    startPid: process.ppid,
    parentPid: procParentPid,
    listTerminals: () => listHerdrCoreTerminals(herdrCoreSocketPath(env)),
  };
}
