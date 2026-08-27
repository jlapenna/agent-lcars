/**
 * A 5-field cron expression (`min hour dom mon dow`), UTC only, minute
 * granularity. No third-party dependency: third-party deps in this repo
 * are root-only and need Renovate (AGENTS.md), and this grammar is small
 * enough not to need one.
 */

interface FieldSpec {
  readonly min: number;
  readonly max: number;
}

const FIELDS: readonly FieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week (0 = Sunday)
];

export interface CronSpec {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
}

/** Parses one cron field ('*', a list 'a,b,c', a range 'a-b', or a step
 *  '*\/n' or 'a-b/n') into the set of matching values within
 *  [spec.min, spec.max]. Throws on anything else -- an invalid cron
 *  expression is a caller bug (a malformed schedule), not a runtime
 *  condition to degrade through. */
function parseField(raw: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const stepMatch = /^(\*|\d+-\d+)\/(\d+)$/u.exec(part);
    const rangeText = stepMatch ? (stepMatch[1] ?? '*') : part;
    const stepText = stepMatch ? stepMatch[2] : undefined;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`invalid cron step in "${part}"`);
    }

    let lo: number;
    let hi: number;
    if (rangeText === '*') {
      lo = spec.min;
      hi = spec.max;
    } else {
      const rangeMatch = /^(\d+)(?:-(\d+))?$/u.exec(rangeText);
      if (rangeMatch === null) {
        throw new Error(`invalid cron field "${part}"`);
      }
      lo = Number(rangeMatch[1]);
      hi = rangeMatch[2] === undefined ? lo : Number(rangeMatch[2]);
    }
    if (lo > hi || lo < spec.min || hi > spec.max) {
      throw new Error(
        `cron field "${part}" out of range [${spec.min}, ${spec.max}]`,
      );
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/** Parses a 5-field UTC cron expression. Throws `Error` when the
 *  expression is not exactly 5 whitespace-separated fields, or any field
 *  is malformed or out of range. */
export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/u);
  if (fields.length !== 5) {
    throw new Error(
      `cron expression must have 5 fields, got ${fields.length}: "${expr}"`,
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((field, i) =>
    parseField(field as string, FIELDS[i] as FieldSpec),
  );
  return {
    minute: minute as Set<number>,
    hour: hour as Set<number>,
    dayOfMonth: dayOfMonth as Set<number>,
    month: month as Set<number>,
    dayOfWeek: dayOfWeek as Set<number>,
  };
}

/** All five fields are ANDed: a date matches only when minute, hour,
 *  day-of-month, month, AND day-of-week all hold simultaneously. This is
 *  deliberately not POSIX cron's special case, where restricting both
 *  day-of-month and day-of-week ORs them instead ("the 1st, OR any
 *  Friday"). ANDing is simpler to reason about and to test (see
 *  `cron.spec.ts`'s "field combination is ANDed" pinning test), at the
 *  cost of the rare intentionally-POSIX expression not being
 *  expressible -- acceptable for a fleet-internal scheduler. */
function matchesSpec(spec: CronSpec, date: Date): boolean {
  return (
    spec.minute.has(date.getUTCMinutes()) &&
    spec.hour.has(date.getUTCHours()) &&
    spec.dayOfMonth.has(date.getUTCDate()) &&
    spec.month.has(date.getUTCMonth() + 1) &&
    spec.dayOfWeek.has(date.getUTCDay())
  );
}

/** Bounds the backward walk below at just over a year of minutes, so a
 *  legitimate low-frequency cron (e.g. monthly, yearly) is still found,
 *  while a search that somehow never matches cannot loop forever. */
const MAX_LOOKBACK_MINUTES = 366 * 24 * 60;

/**
 * The latest minute boundary `<= now` that matches `spec` and is strictly
 * after `after` (a schedule's `lastSlotAt`, or `undefined` for "never
 * ticked"). Walks backward one minute at a time. Returns `undefined` when
 * no due slot exists in that window -- either every match so far is at or
 * before `after`, or (practically impossible for a valid 5-field
 * expression) nothing matched within {@link MAX_LOOKBACK_MINUTES}.
 */
export function latestDueSlot(
  spec: CronSpec,
  now: Date,
  after?: Date,
): Date | undefined {
  const cursor = new Date(now);
  cursor.setUTCSeconds(0, 0);
  const lowerBound = after === undefined ? undefined : after.getTime();

  for (let step = 0; step < MAX_LOOKBACK_MINUTES; step += 1) {
    if (lowerBound !== undefined && cursor.getTime() <= lowerBound) {
      return undefined;
    }
    if (matchesSpec(spec, cursor)) return new Date(cursor);
    cursor.setUTCMinutes(cursor.getUTCMinutes() - 1);
  }
  return undefined;
}

/** Default horizon for {@link nextDueSlot}: a year of forward search is
 *  enough to catch every legitimate low-frequency cron (monthly, yearly)
 *  while still bounding an impossible expression's cost to one walk, done
 *  once at create time rather than paid by every tick forever. */
const DEFAULT_HORIZON_DAYS = 366;

/**
 * The earliest minute boundary `>= from` that matches `spec`, searching
 * forward up to `horizonDays` days (default {@link DEFAULT_HORIZON_DAYS}).
 * Used only at schedule-create time to reject a cron expression that can
 * never fire -- e.g. `0 0 31 2 *` (no February has a 31st) parses cleanly
 * under this grammar's field-by-field validation but never matches any
 * real date. Returns `undefined` when nothing matches within the horizon.
 */
export function nextDueSlot(
  spec: CronSpec,
  from: Date,
  horizonDays = DEFAULT_HORIZON_DAYS,
): Date | undefined {
  const cursor = new Date(from);
  cursor.setUTCSeconds(0, 0);
  const maxSteps = horizonDays * 24 * 60;

  for (let step = 0; step < maxSteps; step += 1) {
    if (matchesSpec(spec, cursor)) return new Date(cursor);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return undefined;
}

/** Crockford base32 (no I, L, O, U) -- the same alphabet
 *  `WORK_ID_PATTERN` (`contract.ts`) and the orchestrator's `WORK_ID_RE`
 *  accept. Kept local rather than imported from `./ulid`: this module has
 *  no dependency on that file, and nothing else in `libs/work` needs a
 *  Crockford encoder today. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function crockfordTimePrefix(epochMs: number): string {
  let time = epochMs;
  let prefix = '';
  for (let i = 0; i < 10; i += 1) {
    prefix = ALPHABET[time % 32] + prefix;
    time = Math.floor(time / 32);
  }
  return prefix;
}

/**
 * A deterministic work item id for one schedule's due slot: the 10-char
 * Crockford time prefix of `slot.getTime()` (so it sorts and reads like
 * every other ULID) followed by 16 Crockford characters derived from
 * `sha256(scheduleId + ':' + slot.toISOString())`. Retrying the same slot
 * (a re-tick before `lastSlotAt` advances, or a replay) always produces
 * the same id, so minting it is idempotent for free -- the second call
 * hits the item the first mint already created instead of starting a
 * second run. Uses Web Crypto (`globalThis.crypto.subtle`), available in
 * both Node 20+ and the browser, so this stays free of a server-only or
 * Node-only dependency, like every other export of this library.
 */
export async function slotItemId(
  scheduleId: string,
  slot: Date,
): Promise<string> {
  const material = `${scheduleId}:${slot.toISOString()}`;
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(material),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  let suffix = '';
  for (const byte of bytes) suffix += ALPHABET[byte % 32];
  return crockfordTimePrefix(slot.getTime()) + suffix;
}
