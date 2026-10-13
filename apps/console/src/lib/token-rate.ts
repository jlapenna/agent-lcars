/**
 * Tokens / min: the fleet's cost-weighted token spend per minute, from the
 * per-minute deltas hook telemetry records on each session doc
 * (`nextTokenMinutes` in @agent-lcars/telemetry). Dependency-free so the
 * Shuttlebay client island can filter it.
 */

/** The sparkline's 30 complete minutes. */
export const TOKEN_RATE_MINUTES = 30;
/** The headline averages the most recent complete minutes. */
export const TOKEN_RATE_AVERAGE_MINUTES = 5;

const MINUTE_MS = 60_000;

/** One session active in the window, reduced to what the readout needs. */
export interface TokenRateSession {
  agent: string;
  repo?: string;
  /** Absent: the session's writer does not record per-minute tokens. */
  minutes?: { minute: string; tokens: number }[];
}

export interface TokenRateSnapshot {
  sessions: TokenRateSession[];
  /** The read hit its session cap: more sessions were active. */
  capped: boolean;
  /** When the sessions were read; the window ends at this minute. */
  observedAt: string;
}

export interface TokenRate {
  perMinute: number;
  /** Oldest first, one per complete minute. */
  series: number[];
  /** Measured sessions active in the window. */
  sessions: number;
  /** Some active sessions are not measured, or the read was capped. */
  partial: boolean;
}

export interface TokenRateFilter {
  /** `owner/name`. */
  repo?: string;
  /** A Work pipeline: `claude`, `codex` or `opencode`. */
  agent?: string;
}

/** Session agents name the runtime; Work pipelines drop `-code`. */
function pipelineOf(agent: string): string {
  return agent === 'claude-code' ? 'claude' : agent;
}

/**
 * Sums the matching sessions' complete minutes before the read. Undefined
 * when sessions were active but none is measured: there is no source, not a
 * zero. No active session at all is a known zero.
 */
export function tokenRate(
  snapshot: TokenRateSnapshot,
  filter: TokenRateFilter = {},
): TokenRate | undefined {
  const sessions = snapshot.sessions.filter(
    (session) =>
      (!filter.repo || session.repo === filter.repo) &&
      (!filter.agent || pipelineOf(session.agent) === filter.agent),
  );
  const measured = sessions.filter((session) => session.minutes);
  if (sessions.length > 0 && measured.length === 0) return undefined;
  const end =
    Math.floor(Date.parse(snapshot.observedAt) / MINUTE_MS) * MINUTE_MS;
  const series = Array<number>(TOKEN_RATE_MINUTES).fill(0);
  for (const session of measured) {
    for (const { minute, tokens } of session.minutes ?? []) {
      const age = Math.round((end - Date.parse(minute)) / MINUTE_MS);
      // Age 0 is the minute still in progress.
      const slot = TOKEN_RATE_MINUTES - age;
      if (age >= 1 && slot >= 0) series[slot] = (series[slot] ?? 0) + tokens;
    }
  }
  const recent = series.slice(-TOKEN_RATE_AVERAGE_MINUTES);
  return {
    perMinute: Math.round(
      recent.reduce((sum, tokens) => sum + tokens, 0) / recent.length,
    ),
    series,
    sessions: measured.length,
    partial: snapshot.capped || measured.length !== sessions.length,
  };
}

/** The fleet panel's Tokens / min input: a rate, or why there is none. */
export function fleetTokenRate(
  snapshot: TokenRateSnapshot | undefined,
  filter: TokenRateFilter = {},
): TokenRate | { unavailable: string } {
  if (!snapshot) return { unavailable: 'session store unavailable' };
  return tokenRate(snapshot, filter) ?? { unavailable: 'no per-minute data' };
}
