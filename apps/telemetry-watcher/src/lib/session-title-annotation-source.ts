import {
  isSafeIdentifier,
  parseSessionStatusAnnotationV1,
  parseSessionTitleAnnotationV1,
  SessionStatusAnnotationV1,
  SessionTitleAnnotationV1,
} from '@agent-lcars/telemetry';
import * as fs from 'fs';
import * as path from 'path';

import {
  DECLARED_TITLE_SUBDIRECTORY,
  sessionTitleChannelDirectory,
  STATUS_SUBDIRECTORY,
} from './session-title-paths';

/** Limits local untrusted input work per read; a directory above this bound is
 * skipped wholesale rather than selecting an enumeration-order-dependent
 * subset. */
export const MAX_SESSION_TITLE_ANNOTATION_FILES = 256;
export const MAX_SESSION_TITLE_ANNOTATION_BYTES = 16 * 1024;

export interface SessionTitleAnnotationDirectoryEntry {
  name: string;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface SessionTitleAnnotationFileSystem {
  /** Must return at most `maxEntries + 1` entries. The extra entry signals an
   * overflow so the caller can fail closed without materializing a large dir.
   */
  readDirectory: (
    directory: string,
    maxEntries: number,
  ) => readonly SessionTitleAnnotationDirectoryEntry[];
  /** Returns undefined when a regular final file exceeds `maxBytes`. */
  readFile: (filePath: string, maxBytes: number) => string | undefined;
  joinPath: (directory: string, filename: string) => string;
}

function readDirectoryBounded(
  directory: string,
  maxEntries: number,
): SessionTitleAnnotationDirectoryEntry[] {
  const handle = fs.opendirSync(directory);
  try {
    const entries: SessionTitleAnnotationDirectoryEntry[] = [];
    while (entries.length <= maxEntries) {
      const entry = handle.readSync();
      if (!entry) {
        break;
      }
      entries.push(entry);
    }
    return entries;
  } finally {
    handle.closeSync();
  }
}

function readFileBounded(
  filePath: string,
  maxBytes: number,
): string | undefined {
  // Refuse instead of following a symlink on a platform without this POSIX
  // primitive. The host deployment is Linux, and a future non-POSIX reader
  // can provide its own equivalently safe injected seam.
  if (fs.constants.O_NOFOLLOW === undefined) {
    return undefined;
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      return undefined;
    }
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    const bytesRead = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    return bytesRead > maxBytes
      ? undefined
      : bytes.toString('utf8', 0, bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
}

const defaultFileSystem: SessionTitleAnnotationFileSystem = {
  readDirectory: readDirectoryBounded,
  readFile: readFileBounded,
  joinPath: path.join,
};

function filenameSessionId(filename: string): string | undefined {
  if (!filename.endsWith('.json')) {
    return undefined;
  }

  const sessionId = filename.slice(0, -'.json'.length);
  // The parser repeats the existing safe-identifier check before accepting
  // parsed content. This narrower filename guard happens first so a hostile
  // injected/unsupported directory entry can never alter `directory` via
  // `joinPath` before that parser boundary is reached.
  return isSafeIdentifier(sessionId) ? sessionId : undefined;
}

/**
 * One channel directory's read outcome. `available` and "has annotations"
 * are independent axes on purpose — see {@link readSessionTitleDirectory}'s
 * doc comment for the full argument. Callers that need last-good retention
 * (`daemon.ts`) branch on `available`; callers that only ever want "whatever
 * candidates exist right now" (the legacy `readSessionTitleAnnotations`
 * below) can ignore it and read `annotations` alone.
 */
export interface SessionTitleDirectoryRead {
  readonly available: boolean;
  readonly annotations: ReadonlyMap<string, SessionTitleAnnotationV1>;
}

/**
 * Reads one channel directory's complete final annotation files, returning
 * validated candidates in filename order alongside whether the directory
 * itself was usable this read. Generic over the parsed annotation shape
 * (issue #1257) — the title channels and the status channel share this
 * exact reading algorithm byte for byte, differing only in which `parse`
 * function validates a file's parsed JSON content. See
 * `v1-text-envelope.ts` (`@agent-lcars/telemetry`) for the matching split on
 * the parser side.
 *
 * `available: false` means the directory read failed wholesale — missing,
 * unreadable (permissions, not-a-directory, raced out from under us), or
 * over {@link MAX_SESSION_TITLE_ANNOTATION_FILES} (fails closed rather than
 * selecting an enumeration-order-dependent subset, same reasoning as the
 * per-file bound below). It does NOT mean "no annotations" — a directory
 * that opens fine and simply contains zero (or zero *valid*) files is
 * `available: true` with an empty map, because "the channel currently has
 * nothing to say" and "the channel couldn't be read at all" are different
 * facts a caller doing last-good retention needs to tell apart: the former
 * should overwrite what was last known-good (there might genuinely be
 * nothing declared right now), the latter should preserve it (a transient
 * hiccup shouldn't blank every title on this tick).
 *
 * A single malformed, partial, unreadable, or raced FILE is skipped without
 * affecting `available` — that failure is scoped to the one file, not the
 * directory it lives in, so a broken sibling never prevents a valid file
 * from being returned.
 */
function readAnnotationDirectory<T extends { sessionId: string }>(
  directory: string,
  fileSystem: SessionTitleAnnotationFileSystem,
  parse: (value: unknown, filenameSessionId: string) => T | undefined,
): {
  readonly available: boolean;
  readonly annotations: ReadonlyMap<string, T>;
} {
  let entries: readonly SessionTitleAnnotationDirectoryEntry[];
  try {
    entries = fileSystem.readDirectory(
      directory,
      MAX_SESSION_TITLE_ANNOTATION_FILES,
    );
  } catch {
    return { available: false, annotations: new Map() };
  }

  if (entries.length > MAX_SESSION_TITLE_ANNOTATION_FILES) {
    return { available: false, annotations: new Map() };
  }

  const annotations = new Map<string, T>();
  for (const entry of [...entries].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const sessionId = filenameSessionId(entry.name);
    if (!sessionId) {
      continue;
    }

    try {
      if (entry.isSymbolicLink() || !entry.isFile()) {
        continue;
      }
      const content = fileSystem.readFile(
        fileSystem.joinPath(directory, entry.name),
        MAX_SESSION_TITLE_ANNOTATION_BYTES,
      );
      if (
        content === undefined ||
        Buffer.byteLength(content, 'utf8') > MAX_SESSION_TITLE_ANNOTATION_BYTES
      ) {
        continue;
      }

      const annotation = parse(JSON.parse(content), sessionId);
      if (annotation) {
        annotations.set(annotation.sessionId, annotation);
      }
    } catch {
      // A malformed, partial, unreadable, or raced file must never prevent a
      // valid sibling from being returned on this or a later read, and must
      // never mark the whole directory unavailable — see this function's
      // doc comment.
    }
  }
  return { available: true, annotations };
}

function readSessionTitleDirectory(
  directory: string,
  fileSystem: SessionTitleAnnotationFileSystem,
): SessionTitleDirectoryRead {
  return readAnnotationDirectory(
    directory,
    fileSystem,
    parseSessionTitleAnnotationV1,
  );
}

/**
 * Reads only complete final annotation files and returns validated candidates
 * in filename order. This is deliberately not connected to watcher discovery,
 * title precedence, session documents, or any writer.
 *
 * Kept as a thin wrapper over {@link readSessionTitleDirectory} for callers
 * that only need "whatever's readable right now" and have no last-good
 * state to maintain (this directly backs the legacy behaviour this function
 * has always had, and its existing tests).
 */
export function readSessionTitleAnnotations(
  directory: string,
  dependencies: Partial<SessionTitleAnnotationFileSystem> = {},
): ReadonlyMap<string, SessionTitleAnnotationV1> {
  const fileSystem = { ...defaultFileSystem, ...dependencies };
  return readSessionTitleDirectory(directory, fileSystem).annotations;
}

/** Declared-title directory read for one state root, see
 * {@link readSessionTitleOverlay}. */
export interface SessionTitleOverlayRead {
  readonly declared: SessionTitleDirectoryRead;
}

/**
 * Reads the declared title directory beneath `stateDirectory`.
 */
export function readSessionTitleOverlay(
  stateDirectory: string,
  dependencies: Partial<SessionTitleAnnotationFileSystem> = {},
): SessionTitleOverlayRead {
  const fileSystem = { ...defaultFileSystem, ...dependencies };
  return {
    declared: readSessionTitleDirectory(
      sessionTitleChannelDirectory(stateDirectory, DECLARED_TITLE_SUBDIRECTORY),
      fileSystem,
    ),
  };
}

/** One status-channel directory read — see {@link SessionTitleDirectoryRead}
 * (title's own equivalent) for what `available` does and doesn't mean.
 * Status has only one channel (no declared/generated split — see
 * `STATUS_SUBDIRECTORY`'s doc comment), so unlike title there is no
 * "overlay" pair to read, just this single directory. */
export interface SessionStatusDirectoryRead {
  readonly available: boolean;
  readonly annotations: ReadonlyMap<string, SessionStatusAnnotationV1>;
}

/**
 * Reads only complete final status-annotation files and returns validated
 * candidates in filename order — the status-channel analogue of
 * {@link readSessionTitleAnnotations}, for callers that only need "whatever
 * is readable right now" and have no last-good state to maintain.
 */
export function readSessionStatusAnnotations(
  directory: string,
  dependencies: Partial<SessionTitleAnnotationFileSystem> = {},
): ReadonlyMap<string, SessionStatusAnnotationV1> {
  const fileSystem = { ...defaultFileSystem, ...dependencies };
  return readAnnotationDirectory(
    directory,
    fileSystem,
    parseSessionStatusAnnotationV1,
  ).annotations;
}

/**
 * Reads the session-status channel directory beneath `stateDirectory` —
 * `session-status/`, see `session-title-paths.ts`'s `STATUS_SUBDIRECTORY`.
 * The status-channel analogue of {@link readSessionTitleOverlay}: same
 * last-good-retention contract (`available` tracked independently of
 * "has annotations", see {@link SessionTitleDirectoryRead}'s doc comment),
 * collapsed to a single directory since status has no declared/generated
 * split.
 */
export function readSessionStatusOverlay(
  stateDirectory: string,
  dependencies: Partial<SessionTitleAnnotationFileSystem> = {},
): SessionStatusDirectoryRead {
  const fileSystem = { ...defaultFileSystem, ...dependencies };
  return readAnnotationDirectory(
    sessionTitleChannelDirectory(stateDirectory, STATUS_SUBDIRECTORY),
    fileSystem,
    parseSessionStatusAnnotationV1,
  );
}
