import { totalTokens } from './tokens';
import { type TokenMinute, type TokenUsage } from './types';

/** How far back a session doc keeps its per-minute token deltas: the
 * console's Tokens / min readout and sparkline cover the same 30 minutes. */
export const TOKEN_MINUTES_WINDOW = 30;

const MINUTE_MS = 60_000;

/** The start of `iso`'s UTC minute, as an ISO string. */
export function tokenMinuteOf(iso: string): string {
  return new Date(
    Math.floor(Date.parse(iso) / MINUTE_MS) * MINUTE_MS,
  ).toISOString();
}

/** Keeps only well-formed entries from a stored doc: the field is written by
 * every hook client, of whatever version, so it is untrusted input. */
export function parseTokenMinutes(value: unknown): TokenMinute[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (entry): entry is TokenMinute =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as TokenMinute).minute === 'string' &&
      Number.isFinite(Date.parse((entry as TokenMinute).minute)) &&
      Number.isSafeInteger((entry as TokenMinute).tokens) &&
      (entry as TokenMinute).tokens >= 0,
  );
}

/**
 * The session's per-minute token deltas after one write: what the write adds
 * to the stored cost-weighted total (see {@link totalTokens}), credited to
 * the minute the event occurred in, with entries older than
 * {@link TOKEN_MINUTES_WINDOW} minutes before `now` dropped.
 *
 * Nothing is credited when there is no stored total to measure from (the
 * session's first write: its earlier tokens have no known minute) or when
 * the total went down (a re-reduced transcript). The result is still a
 * list, possibly empty, which tells the console this session is measured.
 */
export function nextTokenMinutes(
  stored: { tokens: TokenUsage; tokenMinutes?: unknown } | undefined,
  tokens: TokenUsage,
  occurredAt: string,
  now: string,
): TokenMinute[] {
  const nowMs = Date.parse(now);
  const cutoff = nowMs - TOKEN_MINUTES_WINDOW * MINUTE_MS;
  const kept = (parseTokenMinutes(stored?.tokenMinutes) ?? [])
    .filter((entry) => {
      const at = Date.parse(entry.minute);
      // A minute that ends inside the window still counts.
      return at + MINUTE_MS > cutoff && at <= nowMs;
    })
    .map((entry) => ({ minute: entry.minute, tokens: entry.tokens }));
  const delta = stored ? totalTokens(tokens) - totalTokens(stored.tokens) : 0;
  const occurred = Date.parse(occurredAt);
  if (delta > 0 && Number.isFinite(occurred)) {
    // A late flush is credited when it happened, never in the future.
    const minute = tokenMinuteOf(
      new Date(Math.min(occurred, nowMs)).toISOString(),
    );
    if (Date.parse(minute) + MINUTE_MS > cutoff) {
      const existing = kept.find((entry) => entry.minute === minute);
      if (existing) existing.tokens += delta;
      else kept.push({ minute, tokens: delta });
    }
  }
  return kept
    .sort((a, b) => a.minute.localeCompare(b.minute))
    .slice(-TOKEN_MINUTES_WINDOW - 1);
}
