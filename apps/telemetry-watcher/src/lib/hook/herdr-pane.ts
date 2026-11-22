import { execFile } from 'node:child_process';
import * as fs from 'node:fs';

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

export type HerdrCoreResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly missing: boolean };

export interface HerdrPaneDependencies {
  /** The hook's own parent: the first process that may own a terminal. */
  readonly startPid: number;
  /** The parent of `pid`, or `undefined` when it cannot be read. */
  readonly parentPid: (pid: number) => number | undefined;
  /** Runs `herdr-core <args>`. `missing` means the program is not installed;
   * any other failure, a timeout included, is not. */
  readonly runCore: (args: readonly string[]) => Promise<HerdrCoreResult>;
}

/** A terminal's shell can sit several wrappers above the hook process. */
const MAX_ANCESTORS = 16;
/** More terminals than one person runs; bounds the per-terminal reads. */
const MAX_TERMINALS = 64;
const CORE_TIMEOUT_MS = 1_000;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

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
 * A herdr-core terminal exports no identity of its own, only
 * `HERDR_SOCKET`, and `herdr-core get` with no target cannot resolve itself
 * from a hook, which has no terminal. So the hook lists the live terminals
 * and matches each one's shell and foreground process against its own
 * ancestors. An exported `HERDR_PANE_ID` is deliberately not trusted: any
 * process started under a pane inherits it, including a tmux server whose
 * windows are later attached somewhere else.
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

  const listed = await deps.runCore(['ls', '--json']);
  if (!listed.ok) return { status: listed.missing ? 'none' : 'unknown' };
  const terminals = asRecord(parseJson(listed.stdout))?.['terminals'];
  if (!Array.isArray(terminals)) return { status: 'unknown' };

  const addresses = terminals
    .map((terminal) => asRecord(terminal))
    .filter(
      (terminal) =>
        terminal !== undefined &&
        (terminal['state'] === undefined || terminal['state'] === 'live'),
    )
    .map((terminal) => terminal?.['address'])
    .filter(
      (address): address is string =>
        typeof address === 'string' && isHerdrPaneId(address),
    )
    .slice(0, MAX_TERMINALS);

  let incomplete = false;
  const owners = await Promise.all(
    addresses.map(async (address) => {
      const shown = await deps.runCore(['get', address, '--json']);
      const terminal = shown.ok ? asRecord(parseJson(shown.stdout)) : undefined;
      if (!terminal) {
        incomplete = true;
        return undefined;
      }
      const pids = [
        positivePid(terminal['pid']),
        positivePid(asRecord(terminal['foreground'])?.['pid']),
      ];
      // The nearest ancestor wins, so a terminal started from inside another
      // one is never mistaken for its parent.
      const depth = ancestors.findIndex((ancestor) => pids.includes(ancestor));
      return depth < 0 ? undefined : { address, depth };
    }),
  );
  const nearest = owners
    .filter((owner) => owner !== undefined)
    .sort((left, right) => left.depth - right.depth)[0];
  if (nearest) return { status: 'found', paneId: nearest.address };
  return { status: incomplete ? 'unknown' : 'none' };
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

export function defaultHerdrPaneDependencies(
  env: NodeJS.ProcessEnv = process.env,
  program = 'herdr-core',
): HerdrPaneDependencies {
  return {
    startPid: process.ppid,
    parentPid: procParentPid,
    runCore: (args) =>
      new Promise((resolve) => {
        execFile(
          program,
          [...args],
          {
            env,
            timeout: CORE_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
            encoding: 'utf8',
          },
          (error, stdout) => {
            if (!error) return resolve({ ok: true, stdout });
            resolve({
              ok: false,
              missing: (error as NodeJS.ErrnoException).code === 'ENOENT',
            });
          },
        );
      }),
  };
}
