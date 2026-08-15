import {
  isSafeIdentifier,
  parseSessionTitleAnnotationV1,
  SessionTitleAnnotationV1,
} from '@agent-lcars/telemetry';
import * as fs from 'fs';
import * as path from 'path';

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
 * Reads only complete final annotation files and returns validated candidates
 * in filename order. This is deliberately not connected to watcher discovery,
 * title precedence, session documents, or any writer.
 */
export function readSessionTitleAnnotations(
  directory: string,
  dependencies: Partial<SessionTitleAnnotationFileSystem> = {},
): ReadonlyMap<string, SessionTitleAnnotationV1> {
  const fileSystem = { ...defaultFileSystem, ...dependencies };
  let entries: readonly SessionTitleAnnotationDirectoryEntry[];
  try {
    entries = fileSystem.readDirectory(
      directory,
      MAX_SESSION_TITLE_ANNOTATION_FILES,
    );
  } catch {
    return new Map();
  }

  if (entries.length > MAX_SESSION_TITLE_ANNOTATION_FILES) {
    return new Map();
  }

  const annotations = new Map<string, SessionTitleAnnotationV1>();
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

      const annotation = parseSessionTitleAnnotationV1(
        JSON.parse(content),
        sessionId,
      );
      if (annotation) {
        annotations.set(annotation.sessionId, annotation);
      }
    } catch {
      // A malformed, partial, unreadable, or raced file must never prevent a
      // valid sibling from being returned on this or a later read.
    }
  }
  return annotations;
}
