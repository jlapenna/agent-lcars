import {
  asNumber,
  asRecord,
  asString,
  isSafeIdentifier,
  truncateTitle,
} from './unknown-value';

/**
 * Shared shape underlying every local session-annotation envelope this repo
 * writes to `~/.local/state/agent-lcars/<channel>/<sessionId>.json`: a
 * closed v1 envelope carrying exactly `version`, `sessionId`, `updatedAt`,
 * and ONE free-text field whose name varies by channel (`title` for the
 * declared/generated title channels, `status` for the session-status
 * channel — see `session-title-annotation.ts` / `session-status-annotation
 * .ts`). Factored out here (issue #1257) so the two channels' parsers share
 * one validated implementation instead of two near-identical copies of the
 * four-key closed check, the ISO-timestamp validator, and the
 * `isSafeIdentifier`/`truncateTitle` normalization — the risk with two
 * copies isn't that they'd start out different, it's that a future fix to
 * one (e.g. a timestamp-parsing edge case) would silently not apply to the
 * other.
 */
export type V1TextFieldEnvelope<Field extends string> = {
  version: 1;
  sessionId: string;
  updatedAt: string;
} & Record<Field, string>;

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
 * Validates the only supported local annotation shape for one channel's
 * text field. The filename-derived id is part of the envelope boundary:
 * accepting a different id would allow one final file to claim another
 * session's annotation (title OR status).
 */
export function parseV1TextFieldEnvelope<Field extends string>(
  value: unknown,
  filenameSessionId: string,
  fieldName: Field,
): V1TextFieldEnvelope<Field> | undefined {
  try {
    return parseEnvelope(value, filenameSessionId, fieldName);
  } catch {
    return undefined;
  }
}

function parseEnvelope<Field extends string>(
  value: unknown,
  filenameSessionId: string,
  fieldName: Field,
): V1TextFieldEnvelope<Field> | undefined {
  const requiredKeys = new Set([
    'version',
    'sessionId',
    'updatedAt',
    fieldName,
  ]);
  const annotation = asRecord(value);
  if (!annotation || !isSafeIdentifier(filenameSessionId)) {
    return undefined;
  }

  const keys = Object.getOwnPropertyNames(annotation);
  if (
    keys.length !== requiredKeys.size ||
    Object.getOwnPropertySymbols(annotation).length !== 0 ||
    !keys.every((key) => requiredKeys.has(key))
  ) {
    return undefined;
  }

  const version = asNumber(annotation['version']);
  const sessionId = asString(annotation['sessionId']);
  const updatedAt = asString(annotation['updatedAt']);
  const rawText = asString(annotation[fieldName]);
  if (
    version !== 1 ||
    !sessionId ||
    !isSafeIdentifier(sessionId) ||
    sessionId !== filenameSessionId ||
    !updatedAt ||
    !isValidIsoTimestamp(updatedAt) ||
    rawText === undefined
  ) {
    return undefined;
  }

  const text = truncateTitle(rawText);
  if (!text) {
    return undefined;
  }

  return {
    version: 1,
    sessionId,
    updatedAt,
    [fieldName]: text,
  } as V1TextFieldEnvelope<Field>;
}
