import {
  asNumber,
  asRecord,
  asString,
  isSafeIdentifier,
  truncateTitle,
} from './unknown-value';

/** Closed v1 envelope for an untrusted local session-title candidate. This is
 * intentionally only a parser contract: it does not select, join, or persist
 * a title. */
export interface SessionTitleAnnotationV1 {
  version: 1;
  sessionId: string;
  updatedAt: string;
  title: string;
}

const REQUIRED_KEYS = new Set(['version', 'sessionId', 'updatedAt', 'title']);
const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isValidIsoTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_RE.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) {
    return false;
  }

  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, offset] =
    match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return false;
  }

  if (offset !== 'Z') {
    const [offsetHour, offsetMinute] = offset.slice(1).split(':').map(Number);
    if (offsetHour > 23 || offsetMinute > 59) {
      return false;
    }
  }
  return true;
}

/**
 * Validates the only supported local annotation shape. The filename-derived
 * id is part of the envelope boundary: accepting a different id would allow
 * one final file to claim another session's title.
 */
export function parseSessionTitleAnnotationV1(
  value: unknown,
  filenameSessionId: string,
): SessionTitleAnnotationV1 | undefined {
  try {
    return parseAnnotation(value, filenameSessionId);
  } catch {
    return undefined;
  }
}

function parseAnnotation(
  value: unknown,
  filenameSessionId: string,
): SessionTitleAnnotationV1 | undefined {
  const annotation = asRecord(value);
  if (!annotation || !isSafeIdentifier(filenameSessionId)) {
    return undefined;
  }

  const keys = Object.getOwnPropertyNames(annotation);
  if (
    keys.length !== REQUIRED_KEYS.size ||
    Object.getOwnPropertySymbols(annotation).length !== 0 ||
    !keys.every((key) => REQUIRED_KEYS.has(key))
  ) {
    return undefined;
  }

  const version = asNumber(annotation['version']);
  const sessionId = asString(annotation['sessionId']);
  const updatedAt = asString(annotation['updatedAt']);
  const rawTitle = asString(annotation['title']);
  if (
    version !== 1 ||
    !sessionId ||
    !isSafeIdentifier(sessionId) ||
    sessionId !== filenameSessionId ||
    !updatedAt ||
    !isValidIsoTimestamp(updatedAt) ||
    rawTitle === undefined
  ) {
    return undefined;
  }

  const title = truncateTitle(rawTitle);
  if (!title) {
    return undefined;
  }

  return { version: 1, sessionId, updatedAt, title };
}
