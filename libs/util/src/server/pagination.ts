import { getTimestampFromISODate } from './dates';

export interface ParsedPagination {
  startAfter?: unknown[];
  endBefore?: unknown[];
}

/**
 * Parses pagination cursors from search params.
 * Assumes the cursor is a base64 encoded JSON array `[dateString, id]`.
 */
export function parsePaginationParams(params: {
  after?: string;
  before?: string;
}): ParsedPagination {
  let startAfter: unknown[] | undefined;
  let endBefore: unknown[] | undefined;

  try {
    if (params.after) {
      const decoded = JSON.parse(
        Buffer.from(params.after, 'base64').toString('utf-8'),
      );
      if (Array.isArray(decoded) && decoded.length === 2) {
        const [date, id] = decoded;
        startAfter = [getTimestampFromISODate(date), id];
      }
    } else if (params.before) {
      const decoded = JSON.parse(
        Buffer.from(params.before, 'base64').toString('utf-8'),
      );
      if (Array.isArray(decoded) && decoded.length === 2) {
        const [date, id] = decoded;
        endBefore = [getTimestampFromISODate(date), id];
      }
    }
  } catch (err) {
    console.error('Invalid pagination cursor:', err);
  }

  return { startAfter, endBefore };
}

/**
 * Encodes a cursor array to a base64 string.
 */
export function encodeCursor(cursor: unknown[]): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64');
}
