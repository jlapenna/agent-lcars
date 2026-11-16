import type { RunListCursor } from '@agent-lcars/orchestrator';

/** The `outcomes` query parameter: where the Agents outcome history resumes.
 * Base64url JSON of `[updatedAt, runId]`, so a run id's `#` and `/` survive
 * the URL unescaped by hand. */
export function encodeOutcomeCursor(cursor: RunListCursor): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt, cursor.runId])).toString(
    'base64url',
  );
}

/** A malformed or hand-edited value reads as the newest page. */
export function parseOutcomeCursor(
  value: string | string[] | undefined,
): RunListCursor | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      !Number.isFinite(Date.parse(parsed[0])) ||
      typeof parsed[1] !== 'string' ||
      parsed[1].length === 0
    )
      return undefined;
    return { updatedAt: parsed[0], runId: parsed[1] };
  } catch {
    return undefined;
  }
}
