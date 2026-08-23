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

export const MAX_SESSION_TITLE_ANNOTATION_BYTES = 16 * 1024;

export interface SessionTitleAnnotationFileSystem {
  /** Returns undefined when a regular final file exceeds `maxBytes`. */
  readFile: (filePath: string, maxBytes: number) => string | undefined;
  joinPath: (directory: string, filename: string) => string;
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
  readFile: readFileBounded,
  joinPath: path.join,
};

/**
 * One channel directory's read outcome. `available` and "has annotations"
 * are independent axes. Callers that need last-good retention (`daemon.ts`)
 * branch on `available`.
 */
export interface SessionTitleDirectoryRead {
  readonly available: boolean;
  readonly annotations: ReadonlyMap<string, SessionTitleAnnotationV1>;
}

/** Declared-title directory read for one state root, see
 * {@link readSessionTitleOverlay}. */
export interface SessionTitleOverlayRead {
  readonly declared: SessionTitleDirectoryRead;
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
 * Reads annotations only for sessions the watcher has already discovered
 * from its upstream transcript sources. This avoids directory enumeration:
 * stale annotation files can never make a live session's overlay unavailable
 * or turn every tick into work proportional to historical sessions.
 */
function readAnnotationsForSessions<T extends { sessionId: string }>(
  directory: string,
  sessionIds: Iterable<string>,
  fileSystem: SessionTitleAnnotationFileSystem,
  parse: (value: unknown, filenameSessionId: string) => T | undefined,
): {
  readonly available: boolean;
  readonly annotations: ReadonlyMap<string, T>;
} {
  const annotations = new Map<string, T>();
  let available = true;
  for (const sessionId of sessionIds) {
    if (!isSafeIdentifier(sessionId)) continue;
    let content: string | undefined;
    try {
      content = fileSystem.readFile(
        fileSystem.joinPath(directory, `${sessionId}.json`),
        MAX_SESSION_TITLE_ANNOTATION_BYTES,
      );
    } catch (error) {
      if (!isMissingFile(error)) available = false;
      continue;
    }
    if (content === undefined) continue;
    try {
      const annotation = parse(JSON.parse(content), sessionId);
      if (annotation) annotations.set(annotation.sessionId, annotation);
    } catch {
      // A malformed annotation is scoped to its session, not the overlay.
    }
  }
  return { available, annotations };
}

/**
 * Reads declared titles only for already-discovered sessions.
 */
export function readSessionTitleOverlay(
  stateDirectory: string,
  sessionIds: Iterable<string> = [],
  dependencies: Partial<SessionTitleAnnotationFileSystem> = {},
): SessionTitleOverlayRead {
  const fileSystem = { ...defaultFileSystem, ...dependencies };
  return {
    declared: readAnnotationsForSessions(
      sessionTitleChannelDirectory(stateDirectory, DECLARED_TITLE_SUBDIRECTORY),
      sessionIds,
      fileSystem,
      parseSessionTitleAnnotationV1,
    ),
  };
}

/** One status-channel read. Status has only one channel, so unlike title
 * there is no overlay pair to read. */
export interface SessionStatusDirectoryRead {
  readonly available: boolean;
  readonly annotations: ReadonlyMap<string, SessionStatusAnnotationV1>;
}

/**
 * Reads the session-status channel directory beneath `stateDirectory` —
 * `session-status/`, see `session-title-paths.ts`'s `STATUS_SUBDIRECTORY`.
 */
export function readSessionStatusOverlay(
  stateDirectory: string,
  sessionIds: Iterable<string> = [],
  dependencies: Partial<SessionTitleAnnotationFileSystem> = {},
): SessionStatusDirectoryRead {
  const fileSystem = { ...defaultFileSystem, ...dependencies };
  return readAnnotationsForSessions(
    sessionTitleChannelDirectory(stateDirectory, STATUS_SUBDIRECTORY),
    sessionIds,
    fileSystem,
    parseSessionStatusAnnotationV1,
  );
}
