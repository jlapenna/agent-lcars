import type { Run } from './model';

export const PROVIDER_LIMIT_PROBE_MS = 15 * 60_000;
const MAX_RESET_MS = 7 * 24 * 60 * 60_000;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const CODEX_PROVIDER_FAILURE_PREFIX =
  'Provider quota or usage limit reached. The provider stopped this round before its final message; retained provider failure events: ';
const CODEX_RETRY_NOTICE_PREFIX = 'Reconnecting... ';
const CODEX_RESET_PATTERN =
  /\b[Tt]ry again at (?:([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) )?(\d{1,2}):(\d{2}) (AM|PM)( \(UTC\))?(?=\.(?:\s|$)|\s|$)/gu;

export interface ProviderCooldown {
  pipeline: string;
  runId: string;
  observedAt: string;
  expiresAt: string;
}

/** Only the CLI's explicit UTC reset format supplies a longer hold. */
function claudeReset(message: string, now: number): number | undefined {
  const match =
    /resets (?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), )?(\d{1,2})(?::(\d{2}))?(am|pm) \(UTC\)$/u.exec(
      message,
    );
  if (match === null) return undefined;
  const hour = Number(match[3]);
  const minute = Number(match[4] ?? '0');
  if (hour < 1 || hour > 12 || minute > 59) return undefined;
  const date = new Date(now);
  const month =
    match[1] === undefined ? date.getUTCMonth() : MONTHS.indexOf(match[1]);
  const day = match[2] === undefined ? date.getUTCDate() : Number(match[2]);
  const utcHour = (hour % 12) + (match[5] === 'pm' ? 12 : 0);
  let reset = Date.UTC(date.getUTCFullYear(), month, day, utcHour, minute);
  if (
    new Date(reset).getUTCMonth() !== month ||
    new Date(reset).getUTCDate() !== day
  )
    return undefined;
  if (reset <= now) {
    reset =
      match[1] === undefined
        ? reset + 24 * 60 * 60_000
        : Date.UTC(date.getUTCFullYear() + 1, month, day, utcHour, minute);
  }
  return reset > now && reset - now <= MAX_RESET_MS ? reset : undefined;
}

/** Only a runner-captured CLI failure event or stderr quota banner with a
 * runner-pinned `(UTC)` full calendar date supplies a longer Codex hold; an
 * assistant final message alone (`LAST_MESSAGE_FILE`) never carries the
 * retained-failure envelope and stays on the 15-minute probe. The runner
 * retains one line per event; Codex's retry notices
 * (`Reconnecting... N/M (<err>)`) are transient diagnostics, so a retry hint
 * quoted there never supplies the reset. */
function codexReset(message: string, now: number): number | undefined {
  if (!message.startsWith(CODEX_PROVIDER_FAILURE_PREFIX)) return undefined;
  const events = message
    .slice(CODEX_PROVIDER_FAILURE_PREFIX.length)
    .split('\n')
    .filter((line) => !line.startsWith(CODEX_RETRY_NOTICE_PREFIX))
    .join('\n');
  let reset: number | undefined;
  for (const match of events.matchAll(CODEX_RESET_PATTERN)) {
    if (
      match[1] === undefined ||
      match[2] === undefined ||
      match[3] === undefined ||
      match[7] === undefined
    )
      return undefined;
    const month = MONTHS.indexOf(match[1]);
    const day = Number(match[2]);
    const year = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    if (
      month === -1 ||
      day < 1 ||
      day > 31 ||
      hour < 1 ||
      hour > 12 ||
      minute > 59
    )
      return undefined;
    const utcHour = (hour % 12) + (match[6] === 'PM' ? 12 : 0);
    const candidate = Date.UTC(year, month, day, utcHour, minute);
    const parsed = new Date(candidate);
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month ||
      parsed.getUTCDate() !== day
    )
      return undefined;
    if (reset !== undefined && reset !== candidate) return undefined;
    reset = candidate;
  }
  if (reset === undefined) return undefined;
  return reset > now && reset - now <= MAX_RESET_MS ? reset : undefined;
}

/** Derived from a failed execution report, never from queued task text. */
export function providerCooldownForRun(
  run: Pick<Run, 'runId' | 'state' | 'pipeline' | 'updatedAt' | 'result'>,
): ProviderCooldown | undefined {
  if (run.state !== 'finished' || run.result?.ok !== false) return undefined;
  const message = run.result.message?.trim() ?? '';
  // Only the runner's own classification opens a cooldown: the direct runner
  // reports a provider quota or capacity stop as provider-limit or
  // provider-capacity, never as an unclassified failure.
  if (
    run.result.summary !== 'provider-limit' &&
    run.result.summary !== 'provider-capacity'
  )
    return undefined;
  const now = Date.parse(run.updatedAt);
  if (!Number.isFinite(now)) return undefined;
  // A capacity stop has no reported reset window, so it can only ever get the
  // bounded probe below.
  const reset =
    run.result.summary === 'provider-capacity'
      ? undefined
      : run.pipeline === 'claude'
        ? claudeReset(message, now)
        : run.pipeline === 'codex'
          ? codexReset(message, now)
          : undefined;
  return {
    pipeline: run.pipeline,
    runId: run.runId,
    observedAt: run.updatedAt,
    expiresAt: new Date(reset ?? now + PROVIDER_LIMIT_PROBE_MS).toISOString(),
  };
}

export function providerIsCoolingDown(value: unknown, now: string): boolean {
  if (typeof value !== 'object' || value === null || !('expiresAt' in value))
    return false;
  return (
    typeof value.expiresAt === 'string' &&
    Date.parse(value.expiresAt) > Date.parse(now)
  );
}

/** Keeps an already-active hold when a later completion would shorten it. */
export function shouldWriteProviderCooldown(
  current: unknown,
  next: ProviderCooldown,
): boolean {
  if (!providerIsCoolingDown(current, next.observedAt)) return true;
  if (
    typeof current !== 'object' ||
    current === null ||
    !('expiresAt' in current) ||
    typeof current.expiresAt !== 'string'
  )
    return true;
  return Date.parse(next.expiresAt) >= Date.parse(current.expiresAt);
}
