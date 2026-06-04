import { formatDistanceToNow } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';

// Intl.DateTimeFormat can cause hydration mismatches due to differences in ICU data
// between Node.js (server) and browsers (client), such as NNBSP characters.
// We use date-fns-tz to guarantee identically deterministic strings on all platforms.

type TimestampLike =
  | { seconds: number; nanoseconds: number }
  | { _seconds: number; _nanoseconds: number }
  | Date
  | string
  | number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | any // Compatibility with FieldValue/Timestamp
  | undefined
  | null;

/** Formats as "MM/dd/yyyy" */
export function formatShortDate(value: TimestampLike): string | undefined {
  const date = getDateFromTimestamp(value);
  if (!(date instanceof Date) || isNaN(date.getTime())) return undefined;
  return formatInTimeZone(date, 'UTC', 'MM/dd/yyyy');
}

/** Formats as "EEEE, MMMM d, yyyy" */
export function formatLongDate(value: TimestampLike): string | undefined {
  const date = getDateFromTimestamp(value);
  if (!(date instanceof Date) || isNaN(date.getTime())) return undefined;
  return formatInTimeZone(date, 'UTC', 'EEEE, MMMM d, yyyy');
}

/** Formats using a custom date-fns format string */
export function formatTimestamp(
  value: TimestampLike,
  formatStr: string,
): string | undefined {
  const date = getDateFromTimestamp(value);
  if (!(date instanceof Date) || isNaN(date.getTime())) return undefined;
  return formatInTimeZone(date, 'UTC', formatStr);
}

/**
 * Formats seconds into HH:mm:ss or mm:ss based on duration.
 * Robust implementation using date-fns-tz to avoid timezone side effects.
 */
export function formatDuration(totalSeconds: number): string {
  const date = new Date(totalSeconds * 1000);
  const pattern = totalSeconds >= 3600 ? 'HH:mm:ss' : 'mm:ss';
  return formatInTimeZone(date, 'UTC', pattern);
}

/**
 * Formats seconds into HH:MM:SS or MM:SS, safely handling durations > 24 hours.
 */
export function formatElapsedTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h > 0 ? h : null, m, s]
    .filter((x) => x !== null)
    .map((x) => String(x).padStart(2, '0'))
    .join(':');
}

export function getCurrentYear(): string {
  return new Date().getUTCFullYear().toString();
}

/**
 * Converts a Firestore Timestamp, native Date, or ISO 8601 string to a Date object.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getDateFromTimestamp(value: any): Date | undefined {
  if (value === undefined || value === null) return undefined;

  let date: Date | undefined;

  if (value instanceof Date) {
    date = value;
  } else if (
    value &&
    typeof value === 'object' &&
    'seconds' in value &&
    'nanoseconds' in value
  ) {
    // Firestore Timestamp (client or server)
    if (typeof value.toDate === 'function') {
      const result = value.toDate();
      date = result instanceof Date ? result : new Date(result);
    } else {
      date = new Date(
        value.seconds * 1000 + Math.floor(value.nanoseconds / 1000000),
      );
    }
  } else if (
    value &&
    typeof value === 'object' &&
    '_seconds' in value &&
    '_nanoseconds' in value
  ) {
    // Raw Firestore Timestamp object
    date = new Date(
      value._seconds * 1000 + Math.floor(value._nanoseconds / 1000000),
    );
  } else if (typeof value === 'string' || typeof value === 'number') {
    date = new Date(value);
  }

  if (date instanceof Date && !isNaN(date.getTime())) {
    return date;
  }
  return undefined;
}

export function formatTimestampAsDate(
  value: TimestampLike,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = getDateFromTimestamp(value);
  if (!(date instanceof Date) || isNaN(date.getTime())) return undefined;

  return formatInTimeZone(date, 'UTC', 'yyyy-MM-dd');
}

export function getISODateFromDate(value: TimestampLike) {
  const date = getDateFromTimestamp(value);
  return date && !isNaN(date.getTime()) ? date.toISOString() : undefined;
}

export const formatDateUrl = formatTimestampAsDate;

function withDate(formatString: string) {
  return (value: TimestampLike, timeZone = 'UTC') => {
    const dateObj = getDateFromTimestamp(value);
    if (!dateObj || isNaN(dateObj.getTime())) return '';
    return formatInTimeZone(dateObj, timeZone, formatString);
  };
}

export const formatDateLong = withDate('PPP');
export const formatTime = withDate('p');
export const formatDateShortPrimes = withDate('PP');
export const formatDateTime = withDate('PP p');

export function formatDateRange(
  startDate: TimestampLike,
  endDate: TimestampLike,
  timeZone?: string,
) {
  const start = getDateFromTimestamp(startDate);
  if (!start || isNaN(start.getTime())) return '';

  const end = getDateFromTimestamp(endDate);

  if (end && !isNaN(end.getTime()) && start.getTime() > end.getTime()) {
    throw new Error('End date cannot be before start date');
  }

  const formatFn = (d: Date) => formatDateShortPrimes(d, timeZone);

  if (end && !isNaN(end.getTime()) && formatFn(start) === formatFn(end)) {
    return formatFn(start);
  }

  if (end && !isNaN(end.getTime())) {
    return `${formatFn(start)} - ${formatFn(end)}`;
  }

  return formatFn(start);
}

export function formatDateRelative(
  value: TimestampLike,
  options?: { addSuffix?: boolean },
) {
  const dateObj = getDateFromTimestamp(value);
  if (!dateObj || isNaN(dateObj.getTime())) return '';
  // date-fns formatDistanceToNow is imported dynamically to avoid hydration issues if needed
  // but let's just use it natively.
  return formatDistanceToNow(dateObj, options);
}

export function compareDates(
  a: TimestampLike,
  b: TimestampLike,
  order: 'asc' | 'desc' = 'desc',
) {
  const dateA = getDateFromTimestamp(a)?.getTime() ?? 0;
  const dateB = getDateFromTimestamp(b)?.getTime() ?? 0;

  if (order === 'asc') {
    return dateA - dateB;
  }

  return dateB - dateA;
}

export function isDateAfter(date: TimestampLike, dateToCompare: TimestampLike) {
  const a = getDateFromTimestamp(date);
  const b = getDateFromTimestamp(dateToCompare);
  if (!a || !b || isNaN(a.getTime()) || isNaN(b.getTime())) return false;
  return a.getTime() > b.getTime();
}
