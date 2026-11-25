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
  | {
      readonly status: 'found';
      readonly paneId: string;
      /** The terminal's foreground process when it is the session's own
       * process (an ancestor of the hook), so a later reader can tell that
       * the terminal still runs this session. */
      readonly foreground?: HerdrForegroundProcess;
    }
  | { readonly status: 'none' }
  | { readonly status: 'unknown' };

/**
 * herdr-core's answer to `terminal.list`.
 *
 * `absent` means no core is listening here, which is definite: its socket
 * is not there. Any other failure (a refused or slow connection, an answer
 * that is not one) is not.
 */
/** One process, identified so that a reused PID never matches it. */
export interface HerdrForegroundProcess {
  readonly pid: number;
  /** {@link processStartIdentity}: the boot and the start time of `pid`. */
  readonly start: string;
}

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
  /** {@link processStartIdentity} of `pid`; without it no foreground
   * process is recorded. */
  readonly processStart?: (pid: number) => string | undefined;
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
  let nearest:
    | { address: string; depth: number; foregroundPid: number | undefined }
    | undefined;
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
    const foregroundPid = positivePid(
      asRecord(terminal['foreground'])?.['pid'],
    );
    const pids = [positivePid(terminal['pid']), foregroundPid];
    const depth = ancestors.findIndex((ancestor) => pids.includes(ancestor));
    if (depth >= 0 && (!nearest || depth < nearest.depth)) {
      nearest = {
        address,
        depth,
        // Only a foreground process this hook descends from is the
        // session's own; a shell above it is not.
        foregroundPid:
          foregroundPid !== undefined && ancestors.includes(foregroundPid)
            ? foregroundPid
            : undefined,
      };
    }
  }
  if (!nearest) return { status: 'none' };
  const start =
    nearest.foregroundPid === undefined
      ? undefined
      : deps.processStart?.(nearest.foregroundPid);
  return {
    status: 'found',
    paneId: nearest.address,
    ...(nearest.foregroundPid !== undefined &&
      start !== undefined && {
        foreground: { pid: nearest.foregroundPid, start },
      }),
  };
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

/** The start time field (22nd, clock ticks since boot) of a
 * `/proc/<pid>/stat` line, or `undefined`. */
export function startTicksFromStat(stat: string): string | undefined {
  const close = stat.lastIndexOf(')');
  if (close < 0) return undefined;
  // Fields after the command name start at field 3 (`state`).
  const ticks = stat.slice(close + 2).split(' ')[19];
  return ticks !== undefined && /^[0-9]{1,20}$/.test(ticks) ? ticks : undefined;
}

/**
 * Identifies a process across PID reuse: the kernel's boot id and the
 * process's start time. Two processes with the same identity are the same
 * process. Linux only; anywhere else it is unknown.
 */
export function processStartIdentity(
  pid: number,
  readFile: (filePath: string) => string = (filePath) =>
    fs.readFileSync(filePath, 'utf8'),
): string | undefined {
  try {
    const boot = readFile('/proc/sys/kernel/random/boot_id').trim();
    const ticks = startTicksFromStat(readFile(`/proc/${pid}/stat`));
    return /^[0-9a-f-]{1,64}$/.test(boot) && ticks !== undefined
      ? `${boot}/${ticks}`
      : undefined;
  } catch {
    return undefined;
  }
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
 * One JSON-RPC call's answer from herdr-core.
 *
 * `absent` means no core is listening here (its socket is not there), which
 * is definite. `error` is the core's own refusal, by its `kind`
 * (`not_found`, `finished`...). Anything else failed this time only.
 */
export type HerdrCoreAnswer =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly absent: boolean; readonly error?: string };

/**
 * One call on the core's own socket.
 *
 * The caller connects to the socket itself and never runs the `herdr-core`
 * program: every one of its commands but `--version` starts a core when none
 * is running, which would leave a core and its systemd unit on a host that
 * does not use one, and finding the program would depend on a `PATH` a hook
 * does not reliably inherit. A connection opens in line-delimited JSON-RPC,
 * the mode herdr-core's own `hello` is sent in.
 */
export function callHerdrCore(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number = CORE_TIMEOUT_MS,
): Promise<HerdrCoreAnswer> {
  return new Promise((resolve) => {
    let settled = false;
    let answer = '';
    const socket = net.connect(socketPath);
    const settle = (result: HerdrCoreAnswer) => {
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
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`,
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
      let response: Record<string, unknown> | undefined;
      try {
        response = asRecord(JSON.parse(answer.slice(0, end)));
      } catch {
        response = undefined;
      }
      const error = asRecord(response?.['error']);
      if (error) {
        const kind = asRecord(error['data'])?.['kind'] ?? error['message'];
        settle({
          ok: false,
          absent: false,
          ...(typeof kind === 'string' && { error: kind }),
        });
        return;
      }
      settle(
        response && 'result' in response
          ? { ok: true, result: response['result'] }
          : { ok: false, absent: false },
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

/** One `terminal.list` call, which answers with every terminal's shell and
 * foreground PID. */
export async function listHerdrCoreTerminals(
  socketPath: string,
  timeoutMs: number = CORE_TIMEOUT_MS,
): Promise<HerdrTerminalList> {
  const answer = await callHerdrCore(
    socketPath,
    'terminal.list',
    {},
    timeoutMs,
  );
  if (!answer.ok) return { ok: false, absent: answer.absent };
  const terminals = asRecord(answer.result)?.['terminals'];
  return terminals === undefined
    ? { ok: false, absent: false }
    : { ok: true, terminals };
}

export function defaultHerdrPaneDependencies(
  env: NodeJS.ProcessEnv = process.env,
): HerdrPaneDependencies {
  return {
    startPid: process.ppid,
    parentPid: procParentPid,
    listTerminals: () => listHerdrCoreTerminals(herdrCoreSocketPath(env)),
    processStart: (pid) => processStartIdentity(pid),
  };
}
