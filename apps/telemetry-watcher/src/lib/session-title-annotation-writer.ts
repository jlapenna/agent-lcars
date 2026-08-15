import { isSafeIdentifier, truncateTitle } from '@agent-lcars/telemetry';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const SESSION_TITLE_ANNOTATION_DIRECTORY = path.join(
  '.local',
  'state',
  'agent-lcars',
  'session-metadata',
);

type PinnedWriteSync = (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | null,
) => number;
type PinnedStatSync = (filePath: string) => fs.Stats;
type PinnedLstatSync = (filePath: string) => fs.Stats;

export interface SessionTitleAnnotationWriterFileSystem {
  mkdirSync: typeof fs.mkdirSync;
  openSync: typeof fs.openSync;
  fstatSync: typeof fs.fstatSync;
  fchmodSync: typeof fs.fchmodSync;
  lstatSync: PinnedLstatSync;
  statSync: PinnedStatSync;
  writeSync: PinnedWriteSync;
  fsyncSync: typeof fs.fsyncSync;
  closeSync: typeof fs.closeSync;
  linkSync: typeof fs.linkSync;
  renameSync: typeof fs.renameSync;
  unlinkSync: typeof fs.unlinkSync;
  readlinkSync: typeof fs.readlinkSync;
}

export interface SessionTitleAnnotationWriterDependencies {
  /** Test seam for the host's home directory. The CLI never exposes this. */
  homeDirectory?: string;
  /** Test seam for the pinned state-directory operations. */
  fileSystem?: Partial<SessionTitleAnnotationWriterFileSystem>;
  /** Test seam for modelling another platform or an unavailable primitive. */
  platform?: NodeJS.Platform;
  /** Test seam for deterministic timestamps. */
  now?: () => Date;
  /** Test seam for deterministic unique temporary names. */
  randomBytes?: (size: number) => Buffer;
}

export interface SessionTitleAnnotationWriterResult {
  readonly ok: boolean;
}

interface DirectoryStats {
  isDirectory(): boolean;
}

const defaultFileSystem: SessionTitleAnnotationWriterFileSystem = {
  mkdirSync: fs.mkdirSync,
  openSync: fs.openSync,
  fstatSync: fs.fstatSync,
  fchmodSync: fs.fchmodSync,
  lstatSync: (filePath) => fs.lstatSync(filePath),
  statSync: (filePath) => fs.statSync(filePath),
  writeSync: (fd, buffer, offset, length, position) =>
    fs.writeSync(fd, buffer, offset, length, position),
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  linkSync: fs.linkSync,
  renameSync: fs.renameSync,
  unlinkSync: fs.unlinkSync,
  readlinkSync: fs.readlinkSync,
};

function stateDirectory(
  dependencies: SessionTitleAnnotationWriterDependencies,
): string {
  return path.join(
    dependencies.homeDirectory ?? os.homedir(),
    SESSION_TITLE_ANNOTATION_DIRECTORY,
  );
}

function isDirectory(value: unknown): value is DirectoryStats {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isDirectory' in value &&
    typeof value.isDirectory === 'function' &&
    value.isDirectory()
  );
}

function hasLinuxPrimitives(platform: NodeJS.Platform): boolean {
  return (
    platform === 'linux' &&
    typeof fs.constants.O_DIRECTORY === 'number' &&
    typeof fs.constants.O_NOFOLLOW === 'number' &&
    typeof fs.fsyncSync === 'function'
  );
}

function closeQuietly(
  fileSystem: SessionTitleAnnotationWriterFileSystem,
  descriptor: number | undefined,
): void {
  if (descriptor === undefined) return;
  try {
    fileSystem.closeSync(descriptor);
  } catch {
    // The caller is already handling an operation failure. Do not expose the
    // underlying error, and do not let cleanup obscure the original result.
  }
}

function removeOwnTempQuietly(
  fileSystem: SessionTitleAnnotationWriterFileSystem,
  temporaryPath: string | undefined,
): void {
  if (!temporaryPath) return;
  try {
    // This is the unique name created by this invocation, and is already
    // resolved through the pinned procfd directory.
    fileSystem.unlinkSync(temporaryPath);
  } catch {
    // A crash-safe writer must never broaden cleanup to a directory sweep.
  }
}

function makeTemporaryName(
  sessionId: string,
  randomBytes: (size: number) => Buffer,
): string {
  return `.${sessionId}.${randomBytes(16).toString('hex')}.tmp`;
}

function makeClearCaptureName(
  sessionId: string,
  randomBytes: (size: number) => Buffer,
): string {
  return `.${sessionId}.${randomBytes(16).toString('hex')}.clear.tmp`;
}

function writeFully(
  fileSystem: SessionTitleAnnotationWriterFileSystem,
  descriptor: number,
  content: Buffer,
): void {
  let offset = 0;
  while (offset < content.length) {
    const written = fileSystem.writeSync(
      descriptor,
      content,
      offset,
      content.length - offset,
      null,
    );
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error('short write');
    }
    offset += written;
  }
}

/**
 * Opens the private state directory once and performs all child operations
 * through that descriptor's procfs path. This is intentionally a small,
 * non-activating local primitive: it does not discover or read sessions.
 */
export function writeSessionTitleAnnotation(
  sessionId: string,
  rawTitle: string,
  dependencies: SessionTitleAnnotationWriterDependencies = {},
): SessionTitleAnnotationWriterResult {
  if (!isSafeIdentifier(sessionId)) return { ok: false };

  try {
    const clock = dependencies.now ?? (() => new Date());
    const updatedAt = clock().toISOString();
    const title = truncateTitle(rawTitle);
    if (!title) return { ok: false };
    const annotation = { version: 1, sessionId, updatedAt, title };
    const content = Buffer.from(JSON.stringify(annotation), 'utf8');
    return writeOrClearAnnotation(sessionId, content, dependencies);
  } catch {
    return { ok: false };
  }
}

/** Removes only the current session's final annotation, if it is a regular file. */
export function clearSessionTitleAnnotation(
  sessionId: string,
  dependencies: SessionTitleAnnotationWriterDependencies = {},
): SessionTitleAnnotationWriterResult {
  if (!isSafeIdentifier(sessionId)) return { ok: false };
  const fileSystem = { ...defaultFileSystem, ...dependencies.fileSystem };
  if (!hasLinuxPrimitives(dependencies.platform ?? process.platform)) {
    return { ok: false };
  }

  let directoryDescriptor: number | undefined;
  let captureDescriptor: number | undefined;
  let capturePath: string | undefined;
  let ownsPlaceholder = false;
  try {
    directoryDescriptor = openPinnedDirectory(fileSystem, dependencies);
    const procfdDirectory = procfdPath(directoryDescriptor, fileSystem);
    const finalPath = path.join(procfdDirectory, `${sessionId}.json`);
    capturePath = path.join(
      procfdDirectory,
      makeClearCaptureName(
        sessionId,
        dependencies.randomBytes ?? crypto.randomBytes,
      ),
    );

    // Reserve an invocation-unique capture name before touching the final
    // entry. Renaming the final over this placeholder atomically selects the
    // exact directory entry that clear will inspect; a later writer can safely
    // publish a new final without becoming the object deleted below.
    captureDescriptor = fileSystem.openSync(
      capturePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    ownsPlaceholder = true;
    fileSystem.fchmodSync(captureDescriptor, 0o600);
    fileSystem.closeSync(captureDescriptor);
    captureDescriptor = undefined;

    try {
      fileSystem.renameSync(finalPath, capturePath);
    } catch (error) {
      if (isMissingFile(error)) {
        removeOwnTempQuietly(fileSystem, capturePath);
        capturePath = undefined;
        ownsPlaceholder = false;
        fileSystem.fsyncSync(directoryDescriptor);
        return { ok: true };
      }
      throw error;
    }
    ownsPlaceholder = false;

    const target = fileSystem.lstatSync(capturePath);
    if (target.isFile()) {
      fileSystem.unlinkSync(capturePath);
      capturePath = undefined;
      fileSystem.fsyncSync(directoryDescriptor);
      return { ok: true };
    }

    // `link` is an atomic no-overwrite restore. On Linux it hard-links a
    // symlink or special inode itself rather than following it. If a concurrent
    // writer already recreated the final, EEXIST leaves both that new final and
    // the captured nonregular node intact; clear never deletes either one.
    try {
      fileSystem.linkSync(capturePath, finalPath);
      fileSystem.unlinkSync(capturePath);
      capturePath = undefined;
    } catch {
      // Preserve the captured nonregular object under its ignored private name
      // rather than overwrite a concurrent final or delete an unverified node.
    }
    fileSystem.fsyncSync(directoryDescriptor);
    return { ok: false };
  } catch {
    if (ownsPlaceholder) {
      closeQuietly(fileSystem, captureDescriptor);
      captureDescriptor = undefined;
      removeOwnTempQuietly(fileSystem, capturePath);
    }
    return { ok: false };
  } finally {
    closeQuietly(fileSystem, captureDescriptor);
    closeQuietly(fileSystem, directoryDescriptor);
  }
}

function writeOrClearAnnotation(
  sessionId: string,
  content: Buffer,
  dependencies: SessionTitleAnnotationWriterDependencies,
): SessionTitleAnnotationWriterResult {
  const fileSystem = { ...defaultFileSystem, ...dependencies.fileSystem };
  if (!hasLinuxPrimitives(dependencies.platform ?? process.platform)) {
    return { ok: false };
  }

  let directoryDescriptor: number | undefined;
  let temporaryPath: string | undefined;
  let renamed = false;
  let temporaryDescriptor: number | undefined;
  try {
    directoryDescriptor = openPinnedDirectory(fileSystem, dependencies);
    const procfdDirectory = procfdPath(directoryDescriptor, fileSystem);
    const temporaryName = makeTemporaryName(
      sessionId,
      dependencies.randomBytes ?? crypto.randomBytes,
    );
    temporaryPath = path.join(procfdDirectory, temporaryName);
    const finalPath = path.join(procfdDirectory, `${sessionId}.json`);
    temporaryDescriptor = fileSystem.openSync(
      temporaryPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fileSystem.fchmodSync(temporaryDescriptor, 0o600);
    writeFully(fileSystem, temporaryDescriptor, content);
    fileSystem.fsyncSync(temporaryDescriptor);
    fileSystem.closeSync(temporaryDescriptor);
    temporaryDescriptor = undefined;
    fileSystem.renameSync(temporaryPath, finalPath);
    renamed = true;
    fileSystem.fsyncSync(directoryDescriptor);
    return { ok: true };
  } catch {
    if (!renamed) {
      closeQuietly(fileSystem, temporaryDescriptor);
      removeOwnTempQuietly(fileSystem, temporaryPath);
    }
    return { ok: false };
  } finally {
    closeQuietly(fileSystem, directoryDescriptor);
  }
}

function openPinnedDirectory(
  fileSystem: SessionTitleAnnotationWriterFileSystem,
  dependencies: SessionTitleAnnotationWriterDependencies,
): number {
  const directoryPath = stateDirectory(dependencies);
  fileSystem.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  let descriptor: number | undefined;
  try {
    // O_NOFOLLOW rejects a replaced/symlinked final directory before any child
    // operation. From here onward, permissions and identity are checked on
    // the retained FD, never via the mutable pathname.
    descriptor = fileSystem.openSync(
      directoryPath,
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW,
    );
    if (!isDirectory(fileSystem.fstatSync(descriptor))) {
      throw new Error('invalid state directory');
    }
    fileSystem.fchmodSync(descriptor, 0o700);
    return descriptor;
  } catch (error) {
    closeQuietly(fileSystem, descriptor);
    throw error;
  }
}

function procfdPath(
  directoryDescriptor: number,
  fileSystem: SessionTitleAnnotationWriterFileSystem,
): string {
  const procfdDirectory = `/proc/self/fd/${directoryDescriptor}`;
  const stats = fileSystem.statSync(procfdDirectory);
  if (!isDirectory(stats)) throw new Error('procfd is unavailable');
  // readlink is a deliberate capability check. It ensures this is a procfd
  // symlink, rather than merely a coincidental directory at that pathname.
  const target = fileSystem.readlinkSync(procfdDirectory);
  if (!target) throw new Error('procfd is unavailable');
  return procfdDirectory;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
