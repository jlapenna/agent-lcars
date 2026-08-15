import { DatabaseSync } from 'node:sqlite';

import * as os from 'os';
import * as path from 'path';

const TITLE_MAX_LENGTH = 80;
const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isSafeIdentifier(value: string): boolean {
  return SAFE_IDENTIFIER_RE.test(value);
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Codex's local state DB currently has one `threads` row per conversation.
 * This deliberately narrow projection was observed against Codex's
 * `state_5.sqlite` in August 2026:
 *
 * - `id`: TEXT primary key, the rollout/session id;
 * - `title`: TEXT NOT NULL, Codex's explicit native title;
 * - `updated_at`: INTEGER Unix seconds;
 * - `updated_at_ms`: INTEGER Unix milliseconds (newer, higher precision).
 *
 * The database is Codex-owned implementation detail, so every schema or I/O
 * failure must degrade to no titles. It is never a session-discovery source.
 */
const THREAD_TITLE_QUERY =
  'SELECT id, title, updated_at, updated_at_ms FROM threads';

interface NativeThreadCandidate {
  sessionId: string;
  title: string;
  updatedAtMs: number;
}

export interface ReadCodexNativeTitlesOptions {
  /** Injectable for tests; production uses the local read-only SQLite DB. */
  readRows?: (databasePath: string) => unknown[];
  databasePath?: string;
}

export function defaultCodexNativeStatePath(): string {
  return path.join(os.homedir(), '.codex', 'state_5.sqlite');
}

function nativeTitle(raw: unknown): string | undefined {
  const source = asString(raw);
  if (!source) {
    return undefined;
  }

  // Explicit titles are not a freeform transcript fallback. Reject rather
  // than truncate an overlong source value so a malformed/future state row
  // can never silently replace the existing inferred title.
  const trimmed = source.trim();
  if (trimmed.length === 0 || trimmed.length > TITLE_MAX_LENGTH) {
    return undefined;
  }

  return normalizeTitle(trimmed);
}

function timestampRank(row: Record<string, unknown>): number {
  const updatedAtMs = asNumber(row['updated_at_ms']);
  if (
    updatedAtMs !== undefined &&
    Number.isSafeInteger(updatedAtMs) &&
    updatedAtMs >= 0
  ) {
    return updatedAtMs;
  }

  const updatedAtSeconds = asNumber(row['updated_at']);
  if (
    updatedAtSeconds !== undefined &&
    Number.isSafeInteger(updatedAtSeconds) &&
    updatedAtSeconds >= 0
  ) {
    return updatedAtSeconds * 1_000;
  }

  // The observed table makes both values available. A schema-compatible old
  // row without either timestamp remains usable (its primary key is unique),
  // while synthetic duplicates have a deterministic lexical tie-break below.
  return Number.NEGATIVE_INFINITY;
}

function candidateFromRow(raw: unknown): NativeThreadCandidate | undefined {
  const row = asRecord(raw);
  const sessionId = row && asString(row['id']);
  const title = row && nativeTitle(row['title']);
  if (!sessionId || !isSafeIdentifier(sessionId) || !title) {
    return undefined;
  }

  return { sessionId, title, updatedAtMs: timestampRank(row) };
}

/**
 * Extracts valid native titles from the fixture-frozen SQLite row shape.
 * `threads.id` is a primary key in the supported state schema. The explicit
 * update ranking is defensive for an index snapshot or a future joined query
 * that happens to contain duplicates: newer `updated_at_ms` wins; an exact
 * timestamp tie uses code-unit title order, never input/read order.
 */
export function titlesFromCodexNativeThreadRows(
  rows: Iterable<unknown>,
): ReadonlyMap<string, string> {
  const candidates = new Map<string, NativeThreadCandidate>();
  for (const raw of rows) {
    const candidate = candidateFromRow(raw);
    if (!candidate) {
      continue;
    }

    const previous = candidates.get(candidate.sessionId);
    if (
      !previous ||
      candidate.updatedAtMs > previous.updatedAtMs ||
      (candidate.updatedAtMs === previous.updatedAtMs &&
        candidate.title > previous.title)
    ) {
      candidates.set(candidate.sessionId, candidate);
    }
  }

  return new Map(
    Array.from(candidates, ([sessionId, candidate]) => [
      sessionId,
      candidate.title,
    ]),
  );
}

function readRowsFromDatabase(databasePath: string): unknown[] {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare(THREAD_TITLE_QUERY).all() as unknown[];
  } finally {
    db.close();
  }
}

/**
 * Reads Codex's local title state best-effort. This reader intentionally has
 * no knowledge of transcript roots, allowlists, or storage; `daemon.ts`
 * applies its result only to already accepted Codex transcript sessions.
 */
export function readCodexNativeTitles(
  options: ReadCodexNativeTitlesOptions = {},
): ReadonlyMap<string, string> {
  try {
    const databasePath = options.databasePath ?? defaultCodexNativeStatePath();
    const rows = (options.readRows ?? readRowsFromDatabase)(databasePath);
    return titlesFromCodexNativeThreadRows(rows);
  } catch {
    return new Map();
  }
}
