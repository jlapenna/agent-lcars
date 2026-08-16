import {
  CLI_SESSION_RETENTION_DAYS,
  isSafeIdentifier,
  truncateTitle,
} from '@agent-lcars/telemetry';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DECLARED_TITLE_SUBDIRECTORY,
  GENERATED_TITLE_SUBDIRECTORY,
  SESSION_STATE_DIRECTORY,
  sessionTitleChannelDirectory,
} from './session-title-paths';

/** The `declared` channel's directory, relative to the writer's home
 * directory. Kept as its own export -- it's still the channel most callers
 * (and the reader side) reference directly -- but it's now derived from
 * `session-title-paths.ts`'s shared constants rather than hardcoded here,
 * since `native-titles/` (the `generated` channel) is the same root with a
 * different leaf; see `SessionTitleChannel` below. */
export const SESSION_TITLE_ANNOTATION_DIRECTORY = sessionTitleChannelDirectory(
  SESSION_STATE_DIRECTORY,
  DECLARED_TITLE_SUBDIRECTORY,
);

/** Either of the two directories a title annotation can be written into --
 * the directory itself is what determines a title's tier (`declared` vs.
 * `generated`), so this writer never accepts an arbitrary caller-supplied
 * path. */
export type SessionTitleChannel =
  typeof DECLARED_TITLE_SUBDIRECTORY | typeof GENERATED_TITLE_SUBDIRECTORY;

type PinnedLstatSync = (filePath: string) => fs.Stats;
/** Pinned to the plain-`string[]`, no-`withFileTypes` overload of
 * `fs.readdirSync` -- the pruning sweeps below only ever need a name to
 * re-`lstatSync` themselves (mirroring `clearSessionTitleAnnotation`'s own
 * "trust `lstatSync`, not directory-entry type hints" posture), so pinning
 * avoids the multi-overload union TypeScript would otherwise infer from
 * `typeof fs.readdirSync`. */
type PinnedReaddirSync = (directoryPath: string) => string[];

export interface SessionTitleAnnotationWriterFileSystem {
  mkdirSync: typeof fs.mkdirSync;
  writeFileSync: typeof fs.writeFileSync;
  renameSync: typeof fs.renameSync;
  unlinkSync: typeof fs.unlinkSync;
  lstatSync: PinnedLstatSync;
  readdirSync: PinnedReaddirSync;
  openSync: typeof fs.openSync;
  fsyncSync: typeof fs.fsyncSync;
  closeSync: typeof fs.closeSync;
}

export interface SessionTitleAnnotationWriterDependencies {
  /** Test seam for the host's home directory. The CLI never exposes this. */
  homeDirectory?: string;
  /** Test seam for the pinned state-directory operations. */
  fileSystem?: Partial<SessionTitleAnnotationWriterFileSystem>;
  /** Test seam for deterministic timestamps. */
  now?: () => Date;
  /** Test seam for deterministic unique temporary names. */
  randomBytes?: (size: number) => Buffer;
}

export interface SessionTitleAnnotationWriterResult {
  readonly ok: boolean;
}

const defaultFileSystem: SessionTitleAnnotationWriterFileSystem = {
  mkdirSync: fs.mkdirSync,
  writeFileSync: fs.writeFileSync,
  renameSync: fs.renameSync,
  unlinkSync: fs.unlinkSync,
  lstatSync: (filePath) => fs.lstatSync(filePath),
  readdirSync: (directoryPath) => fs.readdirSync(directoryPath),
  openSync: fs.openSync,
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
};

function channelDirectory(
  channel: SessionTitleChannel,
  dependencies: SessionTitleAnnotationWriterDependencies,
): string {
  return path.join(
    dependencies.homeDirectory ?? os.homedir(),
    sessionTitleChannelDirectory(SESSION_STATE_DIRECTORY, channel),
  );
}

function temporaryName(
  sessionId: string,
  randomBytes: (size: number) => Buffer,
): string {
  return `.${sessionId}.${randomBytes(16).toString('hex')}.tmp`;
}

function removeQuietly(
  fileSystem: SessionTitleAnnotationWriterFileSystem,
  filePath: string | undefined,
): void {
  if (!filePath) return;
  try {
    // This is the unique per-invocation temp name created above -- cleanup
    // never broadens to a directory sweep.
    fileSystem.unlinkSync(filePath);
  } catch {
    // The caller is already handling an operation failure; do not let
    // best-effort cleanup obscure that original result.
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/**
 * Fsyncs the containing directory so a completed rename survives a crash
 * (rename updates a directory entry, and that update itself needs an
 * explicit fsync of the directory to be durable on most filesystems --
 * fsyncing the file alone isn't enough). Deliberately swallows every
 * failure: by the time this runs the rename has already completed, so the
 * annotation is already live and correct on disk. Reporting a failure here
 * would describe a write that, in fact, succeeded.
 */
function fsyncDirectoryQuietly(
  fileSystem: SessionTitleAnnotationWriterFileSystem,
  directoryPath: string,
): void {
  let descriptor: number | undefined;
  try {
    descriptor = fileSystem.openSync(directoryPath, fs.constants.O_RDONLY);
    fileSystem.fsyncSync(descriptor);
  } catch {
    // See doc comment above -- never turns an already-published annotation
    // into a reported failure.
  } finally {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        // Best-effort close; the fsync outcome above already stands.
      }
    }
  }
}

/**
 * Writes one session's title annotation into `channel`, atomically: the
 * full envelope is written to a private per-invocation temp file
 * (`wx` flag, mode 0600) and then renamed into place, and the containing
 * directory is fsynced so that rename survives a crash. Rename-for-
 * atomicity plus directory-fsync-for-durability are the two properties
 * this writer defends; deliberately nothing more.
 *
 * An earlier version of this writer additionally pinned the directory via
 * `/proc/self/fd`, rejected symlinks with `O_NOFOLLOW`, and ran a
 * capture-and-restore dance for `clear`. A #1212 audit removed all of
 * that: it hardened a threat model that doesn't hold here. Writer and
 * reader run as the same uid inside a private (0700) directory under that
 * user's own home; anyone who could exploit a symlink/TOCTOU race in this
 * directory already has equally direct access to the session transcripts
 * this writer is annotating, or to the watcher's Firestore writer key
 * sitting next to it -- the extra machinery bought no real defense, and
 * one of its own failure branches (the old `clearSessionTitleAnnotation`'s
 * post-rename cleanup) could orphan an annotation under a hidden,
 * unrecoverable name while reporting failure. One acknowledged, accepted
 * regression from that removal: a symlinked *state directory itself* (not
 * the final file -- see `clearSessionTitleAnnotation`'s own file-type
 * guard for that) is now followed rather than rejected, because plain
 * `mkdirSync`/`writeFileSync` don't refuse symlinks the way the old
 * `O_NOFOLLOW` directory open did. `O_NOFOLLOW` only ever guarded the leaf
 * component anyway, so it never protected a symlinked `~/.local/state`
 * (one level up) in the first place -- this isn't a new hole, just a
 * narrower guard removed along with everything else.
 */
export function writeSessionTitleAnnotation(
  sessionId: string,
  rawTitle: string,
  channel: SessionTitleChannel,
  dependencies: SessionTitleAnnotationWriterDependencies = {},
): SessionTitleAnnotationWriterResult {
  if (!isSafeIdentifier(sessionId)) return { ok: false };

  const fileSystem = { ...defaultFileSystem, ...dependencies.fileSystem };
  let temporaryPath: string | undefined;
  try {
    const clock = dependencies.now ?? (() => new Date());
    const updatedAt = clock().toISOString();
    const title = truncateTitle(rawTitle);
    if (!title) return { ok: false };
    const content = JSON.stringify({ version: 1, sessionId, updatedAt, title });

    const directory = channelDirectory(channel, dependencies);
    fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const finalPath = path.join(directory, `${sessionId}.json`);
    temporaryPath = path.join(
      directory,
      temporaryName(sessionId, dependencies.randomBytes ?? crypto.randomBytes),
    );

    fileSystem.writeFileSync(temporaryPath, content, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fileSystem.renameSync(temporaryPath, finalPath);
    temporaryPath = undefined;

    fsyncDirectoryQuietly(fileSystem, directory);
    return { ok: true };
  } catch {
    removeQuietly(fileSystem, temporaryPath);
    return { ok: false };
  }
}

/**
 * Removes only the current session's final annotation from `channel`, if
 * present. An absent final is treated as an already-successful clear
 * (idempotent) rather than a failure. Only ever removes a regular file --
 * the kind this writer itself produces; a symlink or FIFO occupying that
 * exact name is left untouched and reported as a failure, since `clear`
 * has no business deleting something it didn't write.
 */
export function clearSessionTitleAnnotation(
  sessionId: string,
  channel: SessionTitleChannel,
  dependencies: SessionTitleAnnotationWriterDependencies = {},
): SessionTitleAnnotationWriterResult {
  if (!isSafeIdentifier(sessionId)) return { ok: false };

  const fileSystem = { ...defaultFileSystem, ...dependencies.fileSystem };
  const directory = channelDirectory(channel, dependencies);
  const finalPath = path.join(directory, `${sessionId}.json`);

  let stats: fs.Stats;
  try {
    stats = fileSystem.lstatSync(finalPath);
  } catch (error) {
    return { ok: isMissingFile(error) };
  }
  if (!stats.isFile()) {
    return { ok: false };
  }

  try {
    fileSystem.unlinkSync(finalPath);
    return { ok: true };
  } catch (error) {
    // Raced away between the lstat above and this unlink -- the desired
    // end state (no final present) already holds either way.
    return { ok: isMissingFile(error) };
  }
}

/**
 * A well-formed final annotation filename's session id, or `undefined` for
 * anything else -- an in-flight `.<id>.<random>.tmp` temp file (leading
 * dot; also excluded because a leading `.` can never satisfy
 * `isSafeIdentifier`), a stray non-`.json` entry, or a filename whose id
 * portion fails that same safety check. Both pruning sweeps below use this
 * as their sole filter for "is this something we're allowed to touch at
 * all", before either one asks a more specific question (in the keep set?
 * older than the horizon?) of what's left.
 *
 * Deliberately duplicated rather than imported from
 * `session-title-annotation-source.ts`'s own private `filenameSessionId`:
 * that module is this issue's read-only reader half (see AGENTS.md) and
 * doesn't export it, and the two checks are simple enough that a shared
 * import would trade a few lines of duplication for a cross-module
 * coupling neither side asked for.
 */
function finalAnnotationSessionId(filename: string): string | undefined {
  if (!filename.endsWith('.json')) return undefined;
  const sessionId = filename.slice(0, -'.json'.length);
  return isSafeIdentifier(sessionId) ? sessionId : undefined;
}

/**
 * Deletes every final in the `generated` channel whose session id is not in
 * `keepSessionIds` -- the importer's own bounded, recency-windowed
 * selection for the run that just completed (see
 * `codex-native-title-source.ts`'s `CODEX_NATIVE_TITLE_IMPORT_CAP`). This
 * is what keeps that directory bounded across repeated runs: the query
 * alone only bounds a single run's writes, but never removes what a
 * *previous* run wrote and this run's window/cap no longer selects, so
 * without this the directory would still accumulate past the reader's cap
 * within a month as the selected set rotates (issue #1224).
 *
 * Safe to call after every import: the generated channel only ever holds
 * machine-imported data that regenerates from the Codex store on the very
 * next run, so removing an entry here costs nothing. Contrast
 * `pruneStaleDeclaredSessionTitleAnnotations` below, which is deliberately
 * far more conservative because a declared title does not regenerate from
 * anything.
 *
 * Scope is hardcoded to `GENERATED_TITLE_SUBDIRECTORY`, not parameterized
 * over `SessionTitleChannel` -- there is no legitimate reason to run a
 * keep-set sweep over `declared`, and hardcoding the channel means a
 * future call site cannot point this at the wrong directory by accident.
 *
 * Ignores (never deletes) anything that isn't a well-formed
 * `<safeId>.json` regular file -- an in-flight temp file, a directory, a
 * symlink, or unrelated debris someone dropped in the directory. Fails
 * soft per entry: one undeletable file (permissions, a raced-away ENOENT,
 * whatever) is simply left in place; it must never abort the sweep or take
 * down the rest of the import.
 */
export function pruneGeneratedSessionTitleAnnotations(
  keepSessionIds: ReadonlySet<string>,
  dependencies: SessionTitleAnnotationWriterDependencies = {},
): void {
  const fileSystem = { ...defaultFileSystem, ...dependencies.fileSystem };
  const directory = channelDirectory(
    GENERATED_TITLE_SUBDIRECTORY,
    dependencies,
  );

  let entries: string[];
  try {
    entries = fileSystem.readdirSync(directory);
  } catch {
    // Missing/unreadable directory -- nothing to prune. A later successful
    // write recreates it anyway.
    return;
  }

  for (const name of entries) {
    const sessionId = finalAnnotationSessionId(name);
    if (!sessionId || keepSessionIds.has(sessionId)) continue;

    const target = path.join(directory, name);
    try {
      const stats = fileSystem.lstatSync(target);
      // Never remove a symlink or directory occupying this name -- same
      // "only ever touch what this writer itself produces" posture as
      // `clearSessionTitleAnnotation` above.
      if (!stats.isFile()) continue;
      fileSystem.unlinkSync(target);
    } catch {
      // Fail soft per entry -- see doc comment above.
    }
  }
}

/**
 * Deletes every final in the `declared` channel whose file is older than
 * `CLI_SESSION_RETENTION_DAYS` (imported from `@agent-lcars/telemetry`'s
 * `session-doc.ts`, not reinvented here -- that module's own comment
 * explains why it's the right horizon to borrow: it's the point past which
 * a `source: 'cli'` session doc itself becomes eligible for Firestore TTL
 * deletion, so a declared title describing a session the console can no
 * longer even display is already dead weight).
 *
 * Deliberately far more conservative than
 * `pruneGeneratedSessionTitleAnnotations` above, because a declared title
 * is a deliberate human or agent statement and deleting one is
 * unrecoverable (see `writeSessionTitleAnnotation`'s own doc comment on
 * this writer's threat model):
 *
 * - Age only, never count -- there is no cap parameter here at all, on
 *   purpose. However many files are in this directory, one still inside
 *   the retention horizon is never touched. If a host genuinely has, say,
 *   256 live titled sessions still inside the window, discarding any of
 *   them to satisfy a count would be discarding intent to solve a problem
 *   that doesn't exist yet; the honest fix at that point is to revisit the
 *   horizon, not to silently start deleting the oldest surviving titles.
 * - Age is the file's own mtime, not `updatedAt` parsed back out of its
 *   JSON body -- avoids a second parse of untrusted content just to decide
 *   whether to delete it, and mtime already tracks exactly "when was this
 *   last actually written": every publish in this writer goes through the
 *   same write-then-rename, and rename updates mtime.
 * - `now` comes through the same injectable clock seam as the rest of this
 *   module (`dependencies.now`), for deterministic tests -- and a
 *   throwing or invalid ("now" that can't produce a finite cutoff) clock
 *   aborts the whole sweep rather than falling through to a `NaN` cutoff,
 *   which would otherwise make every `mtimeMs >= cutoffMs` comparison
 *   false and delete literally everything in the directory. A broken
 *   clock must fail into "prune nothing", never "prune everything".
 *
 * Runs from the same host-side maintenance pass as the Codex import
 * (`session-title-annotation-command.ts`'s `import-native` subcommand),
 * not on a schedule of its own: the systemd timer that re-arms that import
 * every 2 minutes
 * (`deploy/systemd/agent-lcars-session-title-import.timer`) is the only
 * recurring host-side hook this deployment has at all. A reader who finds
 * declared-channel cleanup inside a Codex-titled import path may
 * reasonably wonder why; this is the whole reason -- there is nowhere else
 * to hang a second periodic job, and running it unconditionally (Codex DB
 * present or not) is what actually gives every host this maintenance,
 * since not every host runs Codex at all.
 */
export function pruneStaleDeclaredSessionTitleAnnotations(
  dependencies: SessionTitleAnnotationWriterDependencies = {},
): void {
  const fileSystem = { ...defaultFileSystem, ...dependencies.fileSystem };
  const directory = channelDirectory(DECLARED_TITLE_SUBDIRECTORY, dependencies);

  let entries: string[];
  try {
    entries = fileSystem.readdirSync(directory);
  } catch {
    // Missing/unreadable directory -- nothing to prune.
    return;
  }

  const clock = dependencies.now ?? (() => new Date());
  let cutoffMs: number;
  try {
    cutoffMs =
      clock().getTime() - CLI_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return; // Clock unavailable -- see doc comment above.
  }
  if (!Number.isFinite(cutoffMs)) {
    return; // Invalid Date (e.g. NaN) -- see doc comment above.
  }

  for (const name of entries) {
    const sessionId = finalAnnotationSessionId(name);
    if (!sessionId) continue;

    const target = path.join(directory, name);
    try {
      const stats = fileSystem.lstatSync(target);
      if (!stats.isFile()) continue;
      if (stats.mtimeMs >= cutoffMs) continue; // still inside the horizon
      fileSystem.unlinkSync(target);
    } catch {
      // Fail soft per entry -- one unreadable/undeletable file must never
      // abort the sweep or the rest of the import.
    }
  }
}
