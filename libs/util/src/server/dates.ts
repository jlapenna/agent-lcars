import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { Timestamp } from 'firebase-admin/firestore';

export function getTimestampFromDate(value: Date): Timestamp;
export function getTimestampFromDate(
  value: Date | undefined,
): Timestamp | undefined;
export function getTimestampFromDate(value: Date | undefined) {
  return value ? Timestamp.fromDate(value) : undefined;
}

export function getTimestampFromISODate(value: string): Timestamp;
export function getTimestampFromISODate(
  value: string | undefined,
): Timestamp | undefined;
export function getTimestampFromISODate(value: string | undefined) {
  return value ? Timestamp.fromDate(new Date(value)) : undefined;
}

export function getTimestampFromISOLocalDate(
  value: string,
  timezone: string,
): Timestamp;
export function getTimestampFromISOLocalDate(
  value: string | undefined,
  timezone: string,
): Timestamp | undefined;
export function getTimestampFromISOLocalDate(
  value: string | undefined,
  timezone: string,
) {
  return value ? Timestamp.fromDate(fromZonedTime(value, timezone)) : undefined;
}

/**
 * Server-only duration formatting using high-precision library.
 */
export function formatDurationServer(totalSeconds: number): string {
  const date = new Date(Math.round(totalSeconds * 1000));
  const pattern = totalSeconds >= 3600 ? 'HH:mm:ss.SSS' : 'mm:ss.SSS';
  return formatInTimeZone(date, 'UTC', pattern);
}

export function getDayTimestamp(year: number, month: number, day: number) {
  return Timestamp.fromDate(new Date(year, month, day));
}
