import * as fs from 'node:fs';
import * as path from 'node:path';

import { agentEventSessionIdSchema } from '@agent-lcars/work';

import {
  type HookSessionState,
  hookSessionStateDirectory,
  readHookSessionState,
} from '../hook/hook-state';
import type { DeliveredStore } from './delivered-store';
import type { DeliveryLog } from './delivery-agent';
import type { DeliveryMetrics, SessionReportOutcome } from './metrics';
import type {
  ForwardResult,
  SessionReportKind,
  SessionReportResult,
} from './subscribe-forwarder';
import type { TargetCheck } from './terminal-target';

/**
 * Reports this host's sessions going idle or ending to LCARS, which routes
 * them as `lcars:session:<id>` events (#3538).
 *
 * The trigger is a poll of what the agent already reads to deliver: the
 * hook's per-session state files on this host and, for a session in a
 * herdr-core terminal, the terminal's status through `checkTerminalTarget`.
 * Nothing changes on the hook path, which must stay fast and must never
 * fail an agent, and the hook holds no credential that could reach LCARS.
 *
 * - `ended`: the hook state records the session's end (`lastKind` is
 *   `end`). Reported once per session; the ids already reported are kept in
 *   a small file, so a restart does not report them again.
 * - `idle`: the session's terminal still runs the session and is at its
 *   prompt, after it was seen working (busy), or after the hook recorded a
 *   new `stop` since the last look, which catches a turn shorter than a
 *   tick. It must stay at the prompt for {@link IDLE_SETTLE_MS}, and a
 *   session is reported idle at most once per {@link IDLE_MIN_INTERVAL_MS};
 *   a later idle waits for that window and is sent if the session is still
 *   idle then. A session not in a herdr-core terminal has no status to read
 *   and is never reported idle.
 *
 * Whether anyone subscribed cannot be known on the host, so only sessions
 * with hook state on this host are looked at, and only recently active ones.
 */
export const SESSION_REPORT_TICK_MS = 10_000;
export const IDLE_SETTLE_MS = 10_000;
export const IDLE_MIN_INTERVAL_MS = 5 * 60_000;
/** Hook state older than this is not looked at. */
export const SESSION_LOOKBACK_MS = 24 * 60 * 60_000;
/** Bounds the work of one tick whatever is on disk; the newest win. */
export const MAX_SESSIONS_PER_TICK = 256;
export const REPORT_RETRY_INITIAL_MS = 5_000;
export const REPORT_RETRY_MAX_MS = 5 * 60_000;
/** A report that failed this often is dropped until the agent restarts. */
export const REPORT_MAX_ATTEMPTS = 8;
export const SESSION_REPORTS_FILE = 'session-reports.json';

export interface SessionReporterDeps {
  /** Recently updated hook states on this host. */
  readonly listSessions: () => readonly HookSessionState[];
  readonly checkTarget: (sessionId: string) => Promise<TargetCheck>;
  readonly report: (
    sessionId: string,
    kind: SessionReportKind,
    occurredAt: string,
  ) => Promise<ForwardResult<SessionReportResult>>;
  /** Ended reports already made, by `ended:<session-id>`. */
  readonly reported: DeliveredStore;
  readonly metrics: Pick<DeliveryMetrics, 'countSessionReport'>;
  readonly log: DeliveryLog;
  readonly now: () => number;
}

interface Tracked {
  seq: number;
  working: boolean;
  idleSince?: number;
  lastIdleReport?: number;
}

interface Pending {
  readonly key: string;
  readonly sessionId: string;
  readonly kind: SessionReportKind;
  readonly occurredAt: string;
  attempts: number;
  nextAttemptAt: number;
}

function isoOr(value: string | undefined, fallback: number): string {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return new Date(Number.isFinite(parsed) ? parsed : fallback).toISOString();
}

export class SessionReporter {
  private readonly tracked = new Map<string, Tracked>();
  private readonly pending = new Map<string, Pending>();
  /** Reports given up on; not tried again until the agent restarts. */
  private readonly abandoned = new Set<string>();
  private running = false;

  constructor(private readonly deps: SessionReporterDeps) {}

  /** One look at every recent session, then due reports are sent. A tick
   * that starts while the last one runs does nothing. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.observe();
      await this.send();
    } finally {
      this.running = false;
    }
  }

  private enqueue(
    key: string,
    sessionId: string,
    kind: SessionReportKind,
    occurredAt: string,
  ): void {
    if (this.pending.has(key) || this.abandoned.has(key)) return;
    this.pending.set(key, {
      key,
      sessionId,
      kind,
      occurredAt,
      attempts: 0,
      nextAttemptAt: this.deps.now(),
    });
  }

  private async observe(): Promise<void> {
    const now = this.deps.now();
    const seen = new Set<string>();
    for (const state of this.deps.listSessions()) {
      const { sessionId } = state;
      if (!agentEventSessionIdSchema.safeParse(sessionId).success) continue;
      seen.add(sessionId);
      if (state.lastKind === 'end') {
        this.tracked.delete(sessionId);
        const key = `ended:${sessionId}`;
        if (!this.deps.reported.has(key)) {
          this.enqueue(key, sessionId, 'ended', isoOr(state.updatedAt, now));
        }
        continue;
      }
      if (!state.herdrPaneId || !state.herdrForeground) continue;
      const check = await this.deps.checkTarget(sessionId);
      const previous = this.tracked.get(sessionId);
      if (check.kind === 'gone') {
        this.tracked.delete(sessionId);
        continue;
      }
      if (!previous) {
        // A first look sets the baseline; it is not a transition.
        this.tracked.set(sessionId, {
          seq: state.seq,
          working: check.kind === 'busy',
        });
        continue;
      }
      // Unanswered: look again next tick against the same baseline.
      if (check.kind === 'unavailable') continue;
      const stoppedSince =
        state.seq > previous.seq && state.lastKind === 'stop';
      previous.seq = state.seq;
      if (check.kind === 'busy') {
        previous.working = true;
        previous.idleSince = undefined;
        continue;
      }
      if (
        (previous.working || stoppedSince) &&
        previous.idleSince === undefined
      ) {
        previous.idleSince = now;
        previous.working = false;
      }
      if (
        previous.idleSince !== undefined &&
        now - previous.idleSince >= IDLE_SETTLE_MS &&
        (previous.lastIdleReport === undefined ||
          now - previous.lastIdleReport >= IDLE_MIN_INTERVAL_MS)
      ) {
        const occurredAt = new Date(previous.idleSince).toISOString();
        this.enqueue(
          `idle:${sessionId}:${occurredAt}`,
          sessionId,
          'idle',
          occurredAt,
        );
        previous.lastIdleReport = now;
        previous.idleSince = undefined;
      }
    }
    for (const sessionId of this.tracked.keys()) {
      if (!seen.has(sessionId)) this.tracked.delete(sessionId);
    }
  }

  private async send(): Promise<void> {
    for (const item of [...this.pending.values()]) {
      if (item.nextAttemptAt > this.deps.now()) continue;
      const result = await this.deps.report(
        item.sessionId,
        item.kind,
        item.occurredAt,
      );
      const finish = (outcome: SessionReportOutcome) => {
        this.pending.delete(item.key);
        this.deps.metrics.countSessionReport(item.kind, outcome);
        if (item.kind === 'ended' && outcome !== 'failed') {
          this.deps.reported.record(item.key, this.deps.now());
        }
      };
      if (result.ok) {
        finish('reported');
        this.deps.log({
          level: 'info',
          msg: 'session reported',
          sessionId: item.sessionId,
          kind: item.kind,
          delivered: result.value.delivered,
        });
        continue;
      }
      if (!result.retryable) {
        // LCARS will not take it (the session is not this host's, say);
        // retrying cannot change that.
        finish('rejected');
        this.deps.log({
          level: 'warn',
          msg: 'session report rejected',
          sessionId: item.sessionId,
          kind: item.kind,
          error: result.error,
        });
        continue;
      }
      item.attempts += 1;
      if (item.attempts >= REPORT_MAX_ATTEMPTS) {
        finish('failed');
        this.abandoned.add(item.key);
        this.deps.log({
          level: 'error',
          msg: 'session report failed; giving up',
          sessionId: item.sessionId,
          kind: item.kind,
          error: result.error,
          attempts: item.attempts,
        });
        continue;
      }
      const delay = Math.min(
        REPORT_RETRY_INITIAL_MS * 2 ** (item.attempts - 1),
        REPORT_RETRY_MAX_MS,
      );
      item.nextAttemptAt = this.deps.now() + delay;
      this.deps.metrics.countSessionReport(item.kind, 'retried');
      this.deps.log({
        level: 'warn',
        msg: 'session report failed; retrying',
        sessionId: item.sessionId,
        kind: item.kind,
        error: result.error,
        retryInMs: delay,
      });
    }
  }
}

/** The hook states on this host updated within {@link SESSION_LOOKBACK_MS},
 * newest first, at most {@link MAX_SESSIONS_PER_TICK}. */
export function listRecentHookSessions(
  stateDirectory: string,
  now: number,
): HookSessionState[] {
  const directory = hookSessionStateDirectory(stateDirectory);
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const recent: { sessionId: string; mtime: number }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    try {
      const stat = fs.statSync(path.join(directory, name));
      if (stat.isFile() && now - stat.mtimeMs <= SESSION_LOOKBACK_MS) {
        recent.push({ sessionId: name.slice(0, -5), mtime: stat.mtimeMs });
      }
    } catch {
      // Removed while listing.
    }
  }
  return recent
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_SESSIONS_PER_TICK)
    .flatMap(({ sessionId }) => {
      const state = readHookSessionState(stateDirectory, sessionId);
      return state ? [state] : [];
    });
}
