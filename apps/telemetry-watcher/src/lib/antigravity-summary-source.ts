import { DatabaseSync } from 'node:sqlite';

import { SessionSummary } from '@agent-lcars/telemetry';

/**
 * Antigravity CLI's global summary-tier SQLite DB
 * (`~/.gemini/antigravity-cli/conversation_summaries.db`) — one row per
 * conversation, keyed by `conversation_id` (a UUID that also names files
 * elsewhere under `~/.gemini/antigravity-cli` holding the opaque transcript
 * BLOBs this module never touches — see #3123's phase 3 spike). Schema/column
 * names below were discovered empirically (read-only `sqlite_master`
 * inspection) against an Antigravity CLI install as of 2026-07-19 (`user_version
 * 1`, `schema 4` per the DB header) — if a future CLI release renames or
 * drops one of these columns, `pollAntigravitySummaries` fails soft (logs via
 * `onUnavailable` and returns `[]`) rather than crashing the watcher.
 */
const TABLE = 'conversation_summaries';
const COL_CONVERSATION_ID = 'conversation_id';
const COL_TITLE = 'title';
const COL_STEP_COUNT = 'step_count';
const COL_LAST_MODIFIED_TIME = 'last_modified_time';
const COL_WORKSPACE_URIS = 'workspace_uris';
const COL_LAST_USER_INPUT_TIME = 'last_user_input_time';

const FILE_URI_PREFIX = 'file://';

/** Config shape for the optional Antigravity summary-DB source — see
 * `config.ts`'s `loadConfig` (default-enabled) and `daemon.ts`'s
 * `WatcherDaemonOptions.antigravitySummaryDb`. */
export interface AntigravitySummaryDbConfig {
  /** Absolute path to `conversation_summaries.db`. */
  path: string;
  /** Only rows with at least one `workspace_uris` entry whose filesystem path
   * equals or is nested under one of these prefixes are shipped — see
   * `isAllowedWorkspacePath`. Privacy rule (spike, #3123): summary-tier data
   * for *other* projects on the same workstation must never leave it. */
  workspacePrefixes: string[];
}

export interface PollAntigravitySummariesOptions {
  /** Invoked when the DB can't be opened or queried at all — a missing file
   * (the common case: most hosts don't have the Antigravity CLI installed),
   * a lock/corruption error, or a schema that no longer matches the column
   * constants above. Never invoked for an individual malformed row (those
   * are skipped silently, fail soft — see `toSessionSummary`). `daemon.ts`
   * uses this hook to log a single warning per process instead of one every
   * tick. */
  onUnavailable?: (error: unknown) => void;
}

interface ConversationSummaryRow {
  [COL_CONVERSATION_ID]: unknown;
  [COL_TITLE]: unknown;
  [COL_STEP_COUNT]: unknown;
  [COL_LAST_MODIFIED_TIME]: unknown;
  [COL_WORKSPACE_URIS]: unknown;
  [COL_LAST_USER_INPUT_TIME]: unknown;
}

const GO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d+)?([+-]\d{2}:\d{2}|Z)?$/;

/** Go zero-time year (`time.Time{}`'s default) — Antigravity writes this
 * sentinel (`0001-01-01 00:00:00+00:00`) for `last_user_input_time` on every
 * row observed in a real 221-row production DB (2026-07-19), i.e. the column
 * does not appear to be populated in practice. Treated identically to any
 * other unparseable/absent value: `undefined`, never a bogus year-1 date. */
const GO_ZERO_YEAR = '0001';

/**
 * Antigravity stores timestamps as Go's `time.Time` default string format,
 * e.g. `2026-07-01 00:42:40.565799365+00:00` — space-separated (not `T`),
 * nanosecond-precision (JS `Date` only handles milliseconds), and sometimes
 * fraction-less for the zero sentinel above. Returns `undefined` for
 * anything that isn't a real, non-zero timestamp in this format, so callers
 * can fall back to a value they trust rather than propagate a garbage date.
 */
export function parseGoTimestamp(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const match = GO_TIMESTAMP_RE.exec(raw.trim());
  if (!match) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second, fraction, offsetRaw] = match;
  if (year === GO_ZERO_YEAR) {
    return undefined;
  }
  const millis = fraction ? fraction.slice(1, 4).padEnd(3, '0') : '000';
  const offset = offsetRaw ?? '+00:00';
  const isoCandidate = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}${offset}`;
  const parsedMs = Date.parse(isoCandidate);
  if (Number.isNaN(parsedMs)) {
    return undefined;
  }
  // Re-emit via Date rather than isoCandidate directly: normalizes any
  // non-UTC offset to `Z`, matching every other timestamp this codebase
  // produces (e.g. daemon.ts's `now()`, transcript adapters).
  return new Date(parsedMs).toISOString();
}

/** Parses `workspace_uris` (a JSON array of `file://` URIs, per row) —
 * `undefined` for anything that isn't exactly that shape: empty string (32
 * of 221 rows in the real DB), malformed JSON, or valid JSON that isn't an
 * array of strings. A row with no readable workspace can't be privacy-scoped
 * at all, so it's dropped by the caller rather than guessed at. */
function parseWorkspaceUris(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || !parsed.every((u) => typeof u === 'string')) {
    return undefined;
  }
  return parsed;
}

function fileUriToPath(uri: string): string | undefined {
  if (!uri.startsWith(FILE_URI_PREFIX)) {
    return undefined;
  }
  const raw = uri.slice(FILE_URI_PREFIX.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Prefix match that respects path boundaries — `/home/x/members` must not
 * match a sibling like `/home/x/members2`, but must match any subpath
 * (worktrees included), e.g. `/home/x/members/.claude/worktrees/foo`. */
function isUnderPrefix(fsPath: string, prefix: string): boolean {
  return fsPath === prefix || fsPath.startsWith(`${prefix}/`);
}

/** Returns the first `workspace_uris` filesystem path that falls under one
 * of `allowlistPrefixes`, or `undefined` if none do (the row is entirely
 * out of scope — see `AntigravitySummaryDbConfig.workspacePrefixes`'s doc
 * comment). */
function firstAllowedWorkspacePath(
  uris: string[],
  allowlistPrefixes: string[],
): string | undefined {
  for (const uri of uris) {
    const fsPath = fileUriToPath(uri);
    if (!fsPath) {
      continue;
    }
    if (allowlistPrefixes.some((prefix) => isUnderPrefix(fsPath, prefix))) {
      return fsPath;
    }
  }
  return undefined;
}

function toTurns(raw: unknown): number {
  if (typeof raw === 'number') {
    return raw;
  }
  if (typeof raw === 'bigint') {
    return Number(raw);
  }
  return 0;
}

/**
 * Maps one `conversation_summaries` row into a {@link SessionSummary}, or
 * `undefined` if the row can't be attributed/trusted enough to ship — a
 * missing `conversation_id`, a `workspace_uris` that doesn't parse or has no
 * allowlisted entry, or a `last_modified_time` that doesn't parse. Every
 * check here is a silent skip (fail soft, no per-row log) since a single bad
 * row among ~200 is expected noise, not an operational problem.
 */
function toSessionSummary(
  row: ConversationSummaryRow,
  allowlistPrefixes: string[],
): SessionSummary | undefined {
  const sessionId = row[COL_CONVERSATION_ID];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return undefined;
  }

  const workspaceUris = parseWorkspaceUris(row[COL_WORKSPACE_URIS]);
  if (!workspaceUris) {
    return undefined;
  }

  const cwd = firstAllowedWorkspacePath(workspaceUris, allowlistPrefixes);
  if (!cwd) {
    return undefined;
  }

  const lastActivityAt = parseGoTimestamp(row[COL_LAST_MODIFIED_TIME]);
  if (!lastActivityAt) {
    return undefined;
  }

  // `last_user_input_time` is the Go zero sentinel on every row observed in
  // practice (see `GO_ZERO_YEAR`'s comment) - fall back to the one timestamp
  // this table reliably carries rather than surface a fabricated start time.
  const startedAt =
    parseGoTimestamp(row[COL_LAST_USER_INPUT_TIME]) ?? lastActivityAt;

  const titleRaw = row[COL_TITLE];
  const title =
    typeof titleRaw === 'string' && titleRaw.trim().length > 0
      ? titleRaw.trim()
      : undefined;

  return {
    sessionId,
    source: 'cli',
    agent: 'antigravity',
    cwd,
    startedAt,
    lastActivityAt,
    turns: toTurns(row[COL_STEP_COUNT]),
    toolCallCounts: {},
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    ...(title && { title }),
    deliverables: { prNumbers: [], commitShas: [] },
  };
}

/** Default privacy allowlist — this deployment (pike) is single-tenant for
 * one checkout, mirroring `allowlist.ts`'s `DEFAULT_PROJECT_DIR_ALLOWLIST`
 * hardcoding the same repo path for the same reason. */
export const DEFAULT_ANTIGRAVITY_WORKSPACE_PREFIXES = [
  '/home/jlapenna/p/members',
];

/**
 * Polls Antigravity's summary-tier SQLite DB and returns every row
 * attributable to an allowlisted workspace as a {@link SessionSummary}.
 * Opens read-only (the live CLI writes to this file) and fails soft on any
 * whole-DB problem — missing file, lock contention, or unexpected schema —
 * returning `[]` and invoking `options.onUnavailable` rather than throwing.
 * Stateless: callers that need change-detection (skip re-upserting an
 * unchanged row) or once-per-process warning throttling do that themselves
 * around this function — see `daemon.ts`.
 */
export function pollAntigravitySummaries(
  dbPath: string,
  allowlistPrefixes: string[] = DEFAULT_ANTIGRAVITY_WORKSPACE_PREFIXES,
  options: PollAntigravitySummariesOptions = {},
): SessionSummary[] {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    options.onUnavailable?.(error);
    return [];
  }

  try {
    const rows = db
      .prepare(
        `SELECT ${COL_CONVERSATION_ID}, ${COL_TITLE}, ${COL_STEP_COUNT}, ${COL_LAST_MODIFIED_TIME}, ${COL_WORKSPACE_URIS}, ${COL_LAST_USER_INPUT_TIME} FROM ${TABLE}`,
      )
      .all() as unknown as ConversationSummaryRow[];

    const summaries: SessionSummary[] = [];
    for (const row of rows) {
      const summary = toSessionSummary(row, allowlistPrefixes);
      if (summary) {
        summaries.push(summary);
      }
    }
    return summaries;
  } catch (error) {
    options.onUnavailable?.(error);
    return [];
  } finally {
    try {
      db.close();
    } catch {
      // Already unusable (e.g. the query above proved it isn't a real
      // database) - nothing more to clean up.
    }
  }
}
