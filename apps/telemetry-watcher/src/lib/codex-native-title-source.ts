import { DatabaseSync } from 'node:sqlite';

import { isSafeIdentifier, truncateTitle } from '@agent-lcars/telemetry';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MAX_SESSION_TITLE_ANNOTATION_FILES } from './session-title-annotation-source';

/**
 * Codex's own thread-store SQLite DB (`~/.codex/state_*.sqlite`) -- the
 * only place a Codex session's own title lives. Codex's rollout `.jsonl`
 * transcripts carry no title field at all (verified against a real
 * 560-row DB, `cli_version` 0.147.0), so this is the sole source for
 * Codex's half of the `generated` tier -- see `session-title-paths.ts`'s
 * doc comment on `GENERATED_TITLE_SUBDIRECTORY` for why the import that
 * uses this module runs on the host rather than inside the watcher
 * container (the DB is WAL-mode; a read-only bind mount of it fails
 * outright with `ERR_SQLITE_ERROR: attempt to write a readonly database`).
 *
 * Schema/column names below were frozen from that real DB (`threads`
 * table, `cli_version` 0.147.0) via read-only inspection. If a future
 * Codex release renames or drops one of these columns, every function
 * here fails soft (reports unavailability via `onUnavailable`, returns
 * nothing) rather than crashing an importer run -- the same posture
 * `antigravity-summary-source.ts` uses for an identical class of problem
 * (an external tool's private DB schema this repo doesn't control).
 */
const TABLE = 'threads';
const COL_ID = 'id';
const COL_ROLLOUT_PATH = 'rollout_path';
const COL_NAME = 'name';
const COL_TITLE = 'title';
const COL_UPDATED_AT = 'updated_at';

const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * How many days back an import looks, keyed off `threads.updated_at` (a
 * unix-seconds integer -- verified against the real 560-row DB, not
 * milliseconds). Chosen to match the console's own archive-tier default
 * lookback (`DEFAULT_ARCHIVE_DAYS`, `apps/console/src/lib/
 * archive-window.ts`, also 14) so an imported native title never claims
 * to cover sessions the console's own session-archive page has already
 * stopped surfacing by default. `apps/telemetry-watcher` cannot import
 * that constant directly (it lives in a different app, not a shared lib),
 * so the two are kept in sync by value and by this comment rather than by
 * a shared import -- if the console's default ever moves, revisit this.
 *
 * Measured against the real 560-row store behind issue #1224 (`cli_version`
 * 0.147.0): 1 usable row in the last day, 45 in 7, 95 in 14, 342 in 30, 342
 * total. 14 days keeps today's import comfortably under
 * `CODEX_NATIVE_TITLE_IMPORT_CAP` below (95 < 192) while the unbounded
 * "all time" figure (342) shows why a window is load-bearing on its own,
 * independent of the cap: without one, the selected set could grow
 * forever even before the cap kicks in.
 */
export const CODEX_NATIVE_TITLE_RECENCY_WINDOW_DAYS = 14;

/**
 * Headroom reserved below the reader's hard per-directory cap,
 * `MAX_SESSION_TITLE_ANNOTATION_FILES` (256, `session-title-annotation-
 * source.ts` -- imported, never redefined or raised here). A quarter of
 * that cap, rather than a fixed handful of files, so the reserve scales if
 * the reader's own limit is ever revisited.
 *
 * This exists because `readSessionTitleDirectory` counts every raw
 * directory entry -- including the writer's own in-flight
 * `.<sessionId>.<random>.tmp` temp file -- BEFORE filtering down to valid
 * finals, so writing exactly 256 finals is already one write away from
 * tripping the reader's `available: false` fail-closed path (see that
 * function's doc comment). A one-file margin would only cover that single
 * in-flight temp; this reserves enough to also absorb an orphaned temp a
 * crashed prior run failed to clean up, or two overlapping invocations (a
 * slow run still executing when the next scheduled tick fires -- see
 * `deploy/systemd/agent-lcars-session-title-import.timer`'s own comment on
 * why 2 minutes was judged safe in the common case, not as a hard
 * exclusion guarantee).
 */
export const CODEX_NATIVE_TITLE_IMPORT_HEADROOM = Math.floor(
  MAX_SESSION_TITLE_ANNOTATION_FILES / 4,
);

/**
 * Hard cap on how many rows a single import selects (256 - 64 = 192 today),
 * independent of the recency window above -- the window bounds by time, this
 * bounds by count, and the importer needs both: the window alone still grew
 * without limit before this fix (342 rows with no cutoff at all, per the
 * measurement in `CODEX_NATIVE_TITLE_RECENCY_WINDOW_DAYS`'s comment), and a
 * count cap with no window would retain arbitrarily stale rows forever
 * merely because nothing newer had shown up to evict them.
 *
 * 192 clears today's real 14-day count (95) with more than 2x room to grow
 * before this cap -- rather than the window -- becomes the constraining
 * factor, while still sitting a full quarter of the reader's cap below 256.
 */
export const CODEX_NATIVE_TITLE_IMPORT_CAP =
  MAX_SESSION_TITLE_ANNOTATION_FILES - CODEX_NATIVE_TITLE_IMPORT_HEADROOM;

/** Importer-only env var -- there is no in-container watcher config that
 * needs this path, so (unlike `AGENT_TELEMETRY_ANTIGRAVITY_SUMMARY_DB`,
 * which `config.ts` owns) resolution lives entirely in this module. Same
 * opt-out convention as that var: unset means "use the default discovery
 * below", an explicit empty string means "disable entirely". */
const CODEX_STATE_DB_ENV_VAR = 'AGENT_TELEMETRY_CODEX_STATE_DB';

/** `state_5.sqlite`, `state_6.sqlite`, ... -- the numeric suffix is a
 * schema version Codex itself rotates (state_5 -> state_6 has already
 * happened once in the wild); never hardcode a specific one. The file with
 * the highest suffix is the newest schema and the one the live Codex CLI
 * is writing to. */
const STATE_DB_FILENAME_RE = /^state_(\d+)\.sqlite$/;

export interface ResolveCodexStateDbPathDependencies {
  /** Test seam; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seam for the host's home directory, matching the writer's own
   * seam of the same name (`SessionTitleAnnotationWriterDependencies`). */
  homeDirectory?: string;
}

/**
 * Resolves the Codex state DB path: `AGENT_TELEMETRY_CODEX_STATE_DB` when
 * set (an explicit empty string opts out entirely, returning `undefined`),
 * otherwise the newest `~/.codex/state_*.sqlite` by numeric schema-version
 * suffix. Returns `undefined` when nothing resolves (opted out, no
 * `~/.codex` directory at all, or no matching file yet) -- a config-time
 * "nothing to poll" outcome, not a failure; the common case on any host
 * that doesn't run Codex.
 */
export function resolveCodexStateDbPath(
  dependencies: ResolveCodexStateDbPathDependencies = {},
): string | undefined {
  const env = dependencies.env ?? process.env;
  const override = env[CODEX_STATE_DB_ENV_VAR];
  if (override !== undefined) {
    return override === '' ? undefined : override;
  }

  const codexDirectory = path.join(
    dependencies.homeDirectory ?? os.homedir(),
    '.codex',
  );

  let entries: string[];
  try {
    entries = fs.readdirSync(codexDirectory);
  } catch {
    return undefined;
  }

  let newestVersion = -1;
  let newestFilename: string | undefined;
  for (const filename of entries) {
    const match = STATE_DB_FILENAME_RE.exec(filename);
    if (!match) continue;
    const version = Number(match[1]);
    if (Number.isInteger(version) && version > newestVersion) {
      newestVersion = version;
      newestFilename = filename;
    }
  }
  return newestFilename ? path.join(codexDirectory, newestFilename) : undefined;
}

export interface CodexNativeTitleCandidate {
  readonly sessionId: string;
  readonly title: string;
}

interface ThreadRow {
  [COL_ID]: unknown;
  [COL_ROLLOUT_PATH]: unknown;
  [COL_NAME]: unknown;
  [COL_TITLE]: unknown;
}

interface TableInfoRow {
  name: unknown;
}

/**
 * Maps one `threads` row to a title candidate, or `undefined` if the row
 * can't be trusted/used: an unsafe id, a missing/blank `rollout_path` (the
 * row doesn't correspond to a real on-disk session), or an empty title
 * after `truncateTitle` normalizes it. Every check is a silent skip -- a
 * single bad row among hundreds is expected noise, not an operational
 * problem, matching `antigravity-summary-source.ts`'s `toSessionSummary`.
 *
 * Value preference: `name` -- a deliberate rename Codex only sets when a
 * person or the agent explicitly retitles a thread -- over `title`, which
 * Codex generates automatically for every session. Both still publish into
 * the *same* `generated` channel: the tier a title lands in is determined
 * entirely by which directory the writer targets, not by which column
 * supplied the text (see `session-title-paths.ts`'s doc comment on
 * `GENERATED_TITLE_SUBDIRECTORY`). This is a deliberate simplification,
 * not an oversight: a Codex-generated title and a Codex-deliberate-rename
 * both still rank below a real `declared` title either way, so splitting
 * them into a third tier just to keep them apart would buy nothing.
 */
function toCandidate(row: ThreadRow): CodexNativeTitleCandidate | undefined {
  const sessionId = row[COL_ID];
  if (typeof sessionId !== 'string' || !isSafeIdentifier(sessionId)) {
    return undefined;
  }

  const rolloutPath = row[COL_ROLLOUT_PATH];
  if (typeof rolloutPath !== 'string' || rolloutPath.trim().length === 0) {
    return undefined;
  }

  const nameRaw = row[COL_NAME];
  const titleRaw = row[COL_TITLE];
  const preferred =
    typeof nameRaw === 'string' && nameRaw.trim().length > 0
      ? nameRaw
      : typeof titleRaw === 'string'
        ? titleRaw
        : '';
  const title = truncateTitle(preferred);
  if (!title) {
    return undefined;
  }

  return { sessionId, title };
}

export interface PollCodexNativeTitlesOptions {
  /** Invoked when the DB can't be opened or queried at all -- a missing
   * file (the common case: most hosts don't run Codex, or haven't yet),
   * a lock (a live Codex process can hold it briefly), or a schema that no
   * longer matches the column constants above. Never invoked for an
   * individual malformed row (those are skipped silently -- see
   * `toCandidate`). Same contract as
   * `antigravity-summary-source.ts`'s `PollAntigravitySummariesOptions`. */
  onUnavailable?: (error: unknown) => void;
  /** Test seam for deterministic "now", matching the writer's own seam of
   * the same name (`SessionTitleAnnotationWriterDependencies.now`). Real
   * callers get the wall clock. Drives the recency cutoff below --
   * `threads.updated_at` is unix seconds, so this is converted to seconds
   * before comparison, never milliseconds. */
  now?: () => Date;
}

/**
 * Reads the most recently updated usable rows out of Codex's `threads`
 * table as title candidates, newest first. Opens read-only
 * (`new DatabaseSync(path, { readOnly: true })` -- Codex itself owns writes
 * to this DB) and fails soft on any whole-DB problem, returning `[]` and
 * invoking `onUnavailable` rather than throwing. Unlike
 * `pollAntigravitySummaries`, this opens and closes its own connection on
 * every call rather than keeping one open across polls: this module's only
 * caller is a one-shot CLI invocation
 * (`session-title-annotation-command.ts`'s `import-native` subcommand)
 * that runs once per process and exits, so there is no "next tick" to
 * amortize a kept-open connection across.
 *
 * Bounded at the SQL layer, not in application code, by both a recency
 * window and a hard count cap (`CODEX_NATIVE_TITLE_RECENCY_WINDOW_DAYS` /
 * `CODEX_NATIVE_TITLE_IMPORT_CAP` above) -- see issue #1224: an unbounded
 * `SELECT ... FROM threads` here is exactly what let a single import write
 * more files than the reader's `MAX_SESSION_TITLE_ANNOTATION_FILES` cap
 * tolerates, silently disabling the whole `generated` channel it exists to
 * feed.
 *
 * `LIMIT` is bounded over a query that already carries a cheap qualifying
 * pre-filter (see the inline comment right above it), not the raw table --
 * see issue #1230: bounding raw rows let Codex's numerous, always-untitled
 * per-subagent-thread rows dominate the window and starve out the real
 * titles the cap was meant to hold, so a single import could satisfy the
 * count cap while importing almost nothing. `toCandidate`'s per-row
 * filtering (`isSafeIdentifier`, `truncateTitle`) still runs after, and is
 * still the sole authority on whether a row is usable -- the SQL
 * pre-filter is strictly looser, never stricter, so the returned candidate
 * count can be lower than the cap but never higher.
 */
export function pollCodexNativeTitles(
  dbPath: string,
  options: PollCodexNativeTitlesOptions = {},
): CodexNativeTitleCandidate[] {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    options.onUnavailable?.(error);
    return [];
  }

  try {
    const now = options.now ?? (() => new Date());
    const nowMs = now().getTime();
    if (!Number.isFinite(nowMs)) {
      // An invalid/throwing clock has no principled cutoff to compute --
      // same fail-soft posture as everywhere else in this module, reported
      // through the same `onUnavailable` channel a bad DB uses.
      throw new Error('invalid clock: cannot compute a recency cutoff');
    }
    const cutoffSeconds =
      Math.floor(nowMs / 1000) -
      CODEX_NATIVE_TITLE_RECENCY_WINDOW_DAYS * SECONDS_PER_DAY;

    // `name` was present in Codex 0.147.0 but was removed from the current
    // state_5 schema. Keep deliberate-name preference for older stores while
    // treating its absence as a supported schema variant; selecting the
    // missing column directly makes SQLite reject the whole import before a
    // generated `title` can be read.
    const columns = db
      .prepare(`PRAGMA table_info(${TABLE})`)
      .all() as unknown as TableInfoRow[];
    const hasNameColumn = columns.some((column) => column.name === COL_NAME);
    const nameSelection = hasNameColumn ? COL_NAME : `NULL AS ${COL_NAME}`;
    const titlePredicate = hasNameColumn
      ? `(trim(coalesce(${COL_NAME}, '')) <> '' OR trim(coalesce(${COL_TITLE}, '')) <> '')`
      : `trim(coalesce(${COL_TITLE}, '')) <> ''`;

    // The qualifying predicate below (rollout_path present, name-or-title
    // present) is pushed into SQL so `LIMIT` bounds rows that can actually
    // produce a title -- see issue #1230. Earlier, `LIMIT` bounded the raw,
    // unfiltered `threads` table: Codex writes one row per SUBAGENT thread
    // too, and those rows always have `title = ''` and `name = NULL` (they
    // can never yield a title) but are numerous and recent, so they
    // dominated any recency-ordered window. Measured on a real store: of
    // the top `CODEX_NATIVE_TITLE_IMPORT_CAP` (192) rows by recency, 184
    // were untitled subagent rows and only 8 actually imported, against 95
    // rows in the same window that genuinely qualify. The cap was being
    // spent on rows that could never produce a title.
    //
    // `toCandidate` below remains the sole authority on whether a row is
    // usable (`isSafeIdentifier`, `truncateTitle`) -- this predicate is not
    // a reimplementation of it, only a cheap pre-filter over the two
    // columns `toCandidate` also inspects (`rollout_path`, `name`/`title`).
    // The load-bearing invariant is that this predicate must never be
    // STRICTER than `toCandidate`: over-selecting here is harmless (the
    // strays just get dropped, same as before this predicate existed),
    // but under-selecting would silently discard a valid title before
    // `toCandidate` ever saw it -- the exact class of bug #1230 itself is.
    // Two deliberate slack points keep it on the loose side:
    //   - SQLite's `trim()` strips only ASCII space (0x20) from each end,
    //     never the broader Unicode whitespace class JS's `\s` (and so
    //     `truncateTitle`'s collapse-and-trim) matches -- a `name`/`title`
    //     of e.g. a single tab or U+3000 reads as "non-blank" here but
    //     still reduces to "" in `toCandidate`, and is dropped there
    //     instead of here. Keep it that way; do not "fix" this trim to
    //     match JS more closely, or a row this predicate excludes could
    //     stop being a strict superset of what `toCandidate` accepts.
    //   - `isSafeIdentifier`'s id-shape check is deliberately NOT
    //     reimplemented in SQL at all -- getting an equivalent SQL
    //     predicate exactly as strict (never stricter) as that regex isn't
    //     worth the risk; `toCandidate` alone gates it.
    //
    // `updated_at >= ?` also silently excludes any row with a NULL
    // `updated_at`: SQL comparisons against NULL evaluate to NULL, which
    // WHERE treats as not-matching, regardless of how permissive the rest
    // of the predicate is. This is intentional, not a #1230-shaped
    // dropout: a row with no recorded update time has no recency signal
    // to place it inside or outside the window at all, so there is no
    // "correct" side to err on the way there is for the qualifying
    // predicate above -- treating it as in-window would mean guessing an
    // unbounded age for it, which the whole point of a recency window is
    // to avoid (see `CODEX_NATIVE_TITLE_RECENCY_WINDOW_DAYS`'s doc
    // comment). See `excludes a row with a NULL updated_at` in the spec
    // for the pinned regression.
    const rows = db
      .prepare(
        `SELECT ${COL_ID}, ${COL_ROLLOUT_PATH}, ${nameSelection}, ${COL_TITLE} FROM ${TABLE}
         WHERE ${COL_UPDATED_AT} >= ?
           AND trim(coalesce(${COL_ROLLOUT_PATH}, '')) <> ''
           AND ${titlePredicate}
         ORDER BY ${COL_UPDATED_AT} DESC
         LIMIT ?`,
      )
      .all(
        cutoffSeconds,
        CODEX_NATIVE_TITLE_IMPORT_CAP,
      ) as unknown as ThreadRow[];

    const candidates: CodexNativeTitleCandidate[] = [];
    for (const row of rows) {
      const candidate = toCandidate(row);
      if (candidate) {
        candidates.push(candidate);
      }
    }
    return candidates;
  } catch (error) {
    options.onUnavailable?.(error);
    return [];
  } finally {
    try {
      db.close();
    } catch {
      // Already unusable (e.g. the query above proved it isn't a real
      // database) -- nothing more to clean up.
    }
  }
}
