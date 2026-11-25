import type { HerdrCoreAnswer } from '../hook/herdr-pane';
import type { HookSessionState } from '../hook/hook-state';

/**
 * Whether a notice can be typed into a session's herdr-core terminal now.
 *
 * The session's identity comes from LCARS's own hook state on this host, not
 * from the terminal: the hook records the terminal it found the session in
 * and that terminal's foreground process, which is the session's own process
 * (an ancestor of the hook), identified by boot and start time so a reused
 * PID never matches. A terminal outlives its session, and a dead session
 * reads as idle in telemetry for up to ten minutes, so only the terminal's
 * current foreground process is trusted: it must be exactly that process.
 *
 * - `ready`: the terminal runs the session, which waits at its prompt.
 * - `busy`: it runs the session, which is mid-turn or on an approval prompt.
 * - `unavailable`: herdr-core did not answer this time; ask again.
 * - `gone`: the notice cannot reach this session in this terminal, ever.
 */
export type TargetCheck =
  | { readonly kind: 'ready'; readonly address: string; readonly turn: number }
  | {
      readonly kind: 'busy';
      readonly address: string;
      readonly turn: number;
      readonly status: string;
    }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'gone'; readonly reason: UndeliverableReason };

export const UNDELIVERABLE_REASONS = [
  /** LCARS has no hook state for the session on this host. */
  'unknown-session',
  /** The session recorded its end. */
  'session-ended',
  /** The session is not in a herdr-core terminal, or was found before
   * LCARS recorded the terminal's foreground process. */
  'not-addressable',
  /** The terminal finished or no longer exists. */
  'terminal-gone',
  /** The terminal now runs some other process. */
  'foreground-changed',
  /** The program never reports its status, so a turn cannot be confirmed. */
  'no-status',
  /** Two notices were typed and neither started a turn. */
  'turn-not-started',
] as const;
export type UndeliverableReason = (typeof UNDELIVERABLE_REASONS)[number];

/** herdr-core status words that mean the program waits for input. `done`
 * is what Claude Code reports after a turn; `error` is a turn that failed,
 * leaving the program at its prompt. */
const AT_PROMPT = new Set(['idle', 'done', 'error']);

export interface TerminalTargetDependencies {
  readonly readSession: (sessionId: string) => HookSessionState | undefined;
  /** herdr-core's `terminal.get` for a local address. */
  readonly getTerminal: (address: string) => Promise<HerdrCoreAnswer>;
  /** `processStartIdentity` of a local PID. */
  readonly processStart: (pid: number) => string | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function checkTerminalTarget(
  deps: TerminalTargetDependencies,
  sessionId: string,
): Promise<TargetCheck> {
  const session = deps.readSession(sessionId);
  if (!session) return { kind: 'gone', reason: 'unknown-session' };
  if (session.lastKind === 'end') {
    return { kind: 'gone', reason: 'session-ended' };
  }
  const address = session.herdrPaneId;
  const recorded = session.herdrForeground;
  if (!address || !recorded) {
    return { kind: 'gone', reason: 'not-addressable' };
  }

  const answer = await deps.getTerminal(address);
  if (!answer.ok) {
    return answer.absent ||
      answer.error === 'not_found' ||
      answer.error === 'finished'
      ? { kind: 'gone', reason: 'terminal-gone' }
      : { kind: 'unavailable' };
  }
  const terminal = asRecord(answer.result);
  if (!terminal) return { kind: 'unavailable' };
  if (terminal['state'] !== 'live') {
    return { kind: 'gone', reason: 'terminal-gone' };
  }
  const foregroundPid = asRecord(terminal['foreground'])?.['pid'];
  if (
    foregroundPid !== recorded.pid ||
    deps.processStart(recorded.pid) !== recorded.start
  ) {
    return { kind: 'gone', reason: 'foreground-changed' };
  }
  const status = asRecord(terminal['status'])?.['state'];
  if (typeof status !== 'string') return { kind: 'gone', reason: 'no-status' };
  const rawTurn = terminal['turn'];
  const turn =
    typeof rawTurn === 'number' && Number.isSafeInteger(rawTurn) ? rawTurn : 0;
  return AT_PROMPT.has(status)
    ? { kind: 'ready', address, turn }
    : { kind: 'busy', address, turn, status };
}
