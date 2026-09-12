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

/** Derived from a failed execution report, never from queued task text. */
export function providerCooldownForRun(
  run: Pick<Run, 'runId' | 'state' | 'pipeline' | 'updatedAt' | 'result'>,
): ProviderCooldown | undefined {
  if (run.state !== 'finished' || run.result?.ok !== false) return undefined;
  const message = run.result.message?.trim() ?? '';
  // Old images reported this exact CLI response as no-deliverable. Support
  // those reports during rollout without treating arbitrary failures as quota.
  const legacyClaudeQuota =
    run.pipeline === 'claude' &&
    run.result.summary === 'no-deliverable' &&
    /^You've hit your weekly limit\s*·\s*resets [^\n]+ \(UTC\)$/u.test(message);
  if (run.result.summary !== 'provider-limit' && !legacyClaudeQuota)
    return undefined;
  const now = Date.parse(run.updatedAt);
  if (!Number.isFinite(now)) return undefined;
  const reset =
    run.pipeline === 'claude' ? claudeReset(message, now) : undefined;
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
