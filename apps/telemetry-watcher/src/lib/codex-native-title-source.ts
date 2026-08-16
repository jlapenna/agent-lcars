import { DatabaseSync } from 'node:sqlite';

import { isSafeIdentifier, truncateTitle } from '@agent-lcars/telemetry';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
}

/**
 * Reads every usable row out of Codex's `threads` table as a title
 * candidate. Opens read-only (`new DatabaseSync(path, { readOnly: true })`
 * -- Codex itself owns writes to this DB) and fails soft on any whole-DB
 * problem, returning `[]` and invoking `onUnavailable` rather than
 * throwing. Unlike `pollAntigravitySummaries`, this opens and closes its
 * own connection on every call rather than keeping one open across polls:
 * this module's only caller is a one-shot CLI invocation
 * (`session-title-annotation-command.ts`'s `import-native` subcommand)
 * that runs once per process and exits, so there is no "next tick" to
 * amortize a kept-open connection across.
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
    const rows = db
      .prepare(
        `SELECT ${COL_ID}, ${COL_ROLLOUT_PATH}, ${COL_NAME}, ${COL_TITLE} FROM ${TABLE}`,
      )
      .all() as unknown as ThreadRow[];

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
