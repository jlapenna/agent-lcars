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
  SESSION_STATE_DIRECTORY,
  sessionTitleChannelDirectory,
  STATUS_SUBDIRECTORY,
} from './session-title-paths';

/** The `declared` channel's directory, relative to the writer's home
 * directory. Kept as its own export -- it's still the channel most callers
 * (and the reader side) reference directly -- but it's now derived from
 * `session-title-paths.ts`'s shared constants rather than hardcoded here,
 * from `session-title-paths.ts` rather than hardcoded here. */
export const SESSION_TITLE_ANNOTATION_DIRECTORY = sessionTitleChannelDirectory(
  SESSION_STATE_DIRECTORY,
  DECLARED_TITLE_SUBDIRECTORY,
);

/** Any directory an annotation can be written into -- the directory itself
 * determines whether it is a title or, for `STATUS_SUBDIRECTORY`, a status
 * than a title at all -- so this writer never accepts an arbitrary
 * caller-supplied path. */
export type SessionTitleChannel =
  typeof DECLARED_TITLE_SUBDIRECTORY | typeof STATUS_SUBDIRECTORY;

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
/**
 * Field-generic core of both `writeSessionTitleAnnotation` (below) and
 * `writeSessionStatusAnnotation` -- the two differ only in which envelope
 * key (`title` vs. `status`) carries the free-text value, never in the
 * write mechanics this function owns (temp-file-then-rename, mode 0600,
 * directory fsync). See this module's own doc comment for why that
 * mechanics block is deliberately minimal.
 */
function writeAnnotationFile<Field extends string>(
  sessionId: string,
  rawText: string,
  channel: SessionTitleChannel,
  fieldName: Field,
  dependencies: SessionTitleAnnotationWriterDependencies,
): SessionTitleAnnotationWriterResult {
  if (!isSafeIdentifier(sessionId)) return { ok: false };

  const fileSystem = { ...defaultFileSystem, ...dependencies.fileSystem };
  let temporaryPath: string | undefined;
  try {
    const clock = dependencies.now ?? (() => new Date());
    const updatedAt = clock().toISOString();
    const text = truncateTitle(rawText);
    if (!text) return { ok: false };
    const content = JSON.stringify({
      version: 1,
      sessionId,
      updatedAt,
      [fieldName]: text,
    });

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

export function writeSessionTitleAnnotation(
  sessionId: string,
  rawTitle: string,
  channel: SessionTitleChannel,
  dependencies: SessionTitleAnnotationWriterDependencies = {},
): SessionTitleAnnotationWriterResult {
  return writeAnnotationFile(
    sessionId,
    rawTitle,
    channel,
    'title',
    dependencies,
  );
}

/**
 * Writes one session's status annotation (issue #1257) into the single
 * status channel -- unlike `writeSessionTitleAnnotation`, there is no
 * `channel` parameter: status has only one directory
 * (`STATUS_SUBDIRECTORY`), and hardcoding it here means a future call site
 * cannot point a status write at the wrong directory by accident (same
 * reasoning for hardcoding its own scope). Shares every write-mechanics guarantee
 * `writeSessionTitleAnnotation` has (atomic rename, directory fsync, 0600
 * mode) via the same `writeAnnotationFile` core.
 */
export function writeSessionStatusAnnotation(
  sessionId: string,
  rawStatus: string,
  dependencies: SessionTitleAnnotationWriterDependencies = {},
): SessionTitleAnnotationWriterResult {
  return writeAnnotationFile(
    sessionId,
    rawStatus,
    STATUS_SUBDIRECTORY,
    'status',
    dependencies,
  );
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
 * Removes the current session's status annotation, if present -- the
 * status-channel analogue of `clearSessionTitleAnnotation` above. Already
 * fully channel-generic, so this is a thin wrapper pinning `channel` to
 * `STATUS_SUBDIRECTORY` for the same "no wrong-directory call site"
 * reasoning as `writeSessionStatusAnnotation`.
 */
export function clearSessionStatusAnnotation(
  sessionId: string,
  dependencies: SessionTitleAnnotationWriterDependencies = {},
): SessionTitleAnnotationWriterResult {
  return clearSessionTitleAnnotation(
    sessionId,
    STATUS_SUBDIRECTORY,
    dependencies,
  );
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
 * Deletes every final in the `declared` channel whose file is older than
 * `CLI_SESSION_RETENTION_DAYS` (imported from `@agent-lcars/telemetry`'s
 * `session-doc.ts`, not reinvented here -- that module's own comment
 * explains why it's the right horizon to borrow: it's the point past which
 * a `source: 'cli'` session doc itself becomes eligible for Firestore TTL
 * deletion, so a declared title describing a session the console can no
 * longer even display is already dead weight).
 *
 * Deliberately conservative because a declared title is a deliberate human
 * or agent statement and deleting one is
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
 * Kept as a standalone operation rather than a periodic task: explicit
 * annotations are low-volume and title discovery itself reads only watched
 * upstream JSONL.
 */
export function pruneStaleDeclaredSessionTitleAnnotations(
  dependencies: SessionTitleAnnotationWriterDependencies = {},
): void {
  pruneStaleAnnotations(DECLARED_TITLE_SUBDIRECTORY, dependencies);
}

/**
 * Deletes every final in the status channel whose file is older than
 * `CLI_SESSION_RETENTION_DAYS` -- the status-channel analogue of
 * `pruneStaleDeclaredSessionTitleAnnotations` above, sharing every property
 * that function's own doc comment argues for (age-only, mtime-based,
 * fail-into-nothing on a broken clock). A declared status is the same kind
 * of deliberate agent statement a declared title is, and the same "It must
 * not be able to overflow the reader cap" requirement applies -- an
 * unbounded status channel would eventually exceed
 * `MAX_SESSION_TITLE_ANNOTATION_FILES` and start failing the whole
 * directory closed (see `readSessionStatusOverlay`).
 *
 * Like declared-title pruning, this remains an explicit maintenance
 * operation rather than a recurring host-side task.
 */
export function pruneStaleSessionStatusAnnotations(
  dependencies: SessionTitleAnnotationWriterDependencies = {},
): void {
  pruneStaleAnnotations(STATUS_SUBDIRECTORY, dependencies);
}

function pruneStaleAnnotations(
  channel: SessionTitleChannel,
  dependencies: SessionTitleAnnotationWriterDependencies,
): void {
  const fileSystem = { ...defaultFileSystem, ...dependencies.fileSystem };
  const directory = channelDirectory(channel, dependencies);

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
