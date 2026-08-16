import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_SESSION_TITLE_ANNOTATION_BYTES,
  MAX_SESSION_TITLE_ANNOTATION_FILES,
  readSessionStatusAnnotations,
  readSessionStatusOverlay,
  readSessionTitleAnnotations,
  readSessionTitleOverlay,
  SessionTitleAnnotationDirectoryEntry,
} from './session-title-annotation-source';

const valid = JSON.stringify({
  version: 1,
  sessionId: 'session-title-1',
  updatedAt: '2026-08-15T10:00:00.000Z',
  title: 'Annotated title',
});

const validStatus = JSON.stringify({
  version: 1,
  sessionId: 'session-status-1',
  updatedAt: '2026-08-15T10:00:00.000Z',
  status: 'waiting on CI for #1247',
});

function entry(
  name: string,
  options: { file?: boolean; symlink?: boolean } = {},
): SessionTitleAnnotationDirectoryEntry {
  return {
    name,
    isFile: () => options.file ?? true,
    isSymbolicLink: () => options.symlink ?? false,
  };
}

describe('readSessionTitleAnnotations', () => {
  it('returns validated final files deterministically regardless of enumeration order', () => {
    const entries = [
      entry('a-session.json'),
      entry('session-title-2.json'),
      entry('B-session.json'),
      entry('session-title-1.json'),
    ];
    const contents: Record<string, string> = {
      '/annotations/B-session.json': JSON.stringify({
        version: 1,
        sessionId: 'B-session',
        updatedAt: '2026-08-15T09:59:00.000Z',
        title: 'Uppercase annotation',
      }),
      '/annotations/a-session.json': JSON.stringify({
        version: 1,
        sessionId: 'a-session',
        updatedAt: '2026-08-15T09:59:30.000Z',
        title: 'Lowercase annotation',
      }),
      '/annotations/session-title-1.json': valid,
      '/annotations/session-title-2.json': JSON.stringify({
        version: 1,
        sessionId: 'session-title-2',
        updatedAt: '2026-08-15T10:01:00.000Z',
        title: 'Second annotation',
      }),
    };
    const read = (directoryEntries: SessionTitleAnnotationDirectoryEntry[]) =>
      readSessionTitleAnnotations('/annotations', {
        readDirectory: () => directoryEntries,
        readFile: (filePath) => contents[filePath],
      });

    expect(Array.from(read(entries))).toEqual(
      Array.from(read([...entries].reverse())),
    );
    expect(Array.from(read(entries).keys())).toEqual([
      'B-session',
      'a-session',
      'session-title-1',
      'session-title-2',
    ]);
  });

  it('skips malformed siblings while retaining a valid final file', () => {
    expect(
      readSessionTitleAnnotations('/annotations', {
        readDirectory: () => [
          entry('broken.json'),
          entry('session-title-1.json'),
        ],
        readFile: (filePath) =>
          filePath.endsWith('broken.json') ? '{partial' : valid,
      }),
    ).toEqual(
      new Map([
        [
          'session-title-1',
          {
            version: 1,
            sessionId: 'session-title-1',
            updatedAt: '2026-08-15T10:00:00.000Z',
            title: 'Annotated title',
          },
        ],
      ]),
    );
  });

  it('never reads symlinks, directories, temp files, unrelated files, or unsafe names', () => {
    const readFile = vi.fn(() => valid);
    const result = readSessionTitleAnnotations('/annotations', {
      readDirectory: () => [
        entry('session-title-1.json', { symlink: true }),
        entry('directory.json', { file: false }),
        entry('session-title-1.json.tmp'),
        entry('notes.txt'),
        entry('../escape.json'),
      ],
      readFile,
    });

    expect(result).toEqual(new Map());
    expect(readFile).not.toHaveBeenCalled();
  });

  it('rechecks the opened descriptor before reading a stale regular-file entry', () => {
    expect(
      readSessionTitleAnnotations('/annotations', {
        readDirectory: () => [entry('null.json')],
        joinPath: () => '/dev/null',
      }),
    ).toEqual(new Map());
  });

  it('fails soft for an absent directory, unreadable file, and oversized content', () => {
    expect(
      readSessionTitleAnnotations('/missing', {
        readDirectory: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toEqual(new Map());

    const contents = new Map<string, string | undefined>([
      ['/annotations/session-title-1.json', undefined],
      [
        '/annotations/session-title-2.json',
        'x'.repeat(MAX_SESSION_TITLE_ANNOTATION_BYTES + 1),
      ],
    ]);
    expect(
      readSessionTitleAnnotations('/annotations', {
        readDirectory: () => [
          entry('session-title-1.json'),
          entry('session-title-2.json'),
        ],
        readFile: (filePath) => contents.get(filePath),
      }),
    ).toEqual(new Map());
  });

  it('fails closed on an oversized directory and accepts a complete file after an atomic rename', () => {
    expect(
      readSessionTitleAnnotations('/annotations', {
        readDirectory: () =>
          Array.from(
            { length: MAX_SESSION_TITLE_ANNOTATION_FILES + 1 },
            (_, index) => entry(`session-${index}.json`),
          ),
      }),
    ).toEqual(new Map());

    let entries = [entry('session-title-1.json.tmp')];
    const dependencies = {
      readDirectory: () => entries,
      readFile: () => valid,
    };
    expect(readSessionTitleAnnotations('/annotations', dependencies)).toEqual(
      new Map(),
    );
    entries = [entry('session-title-1.json')];
    expect(readSessionTitleAnnotations('/annotations', dependencies)).toEqual(
      expect.any(Map),
    );
    expect(
      readSessionTitleAnnotations('/annotations', dependencies).get(
        'session-title-1',
      ),
    ).toMatchObject({ title: 'Annotated title' });
  });
});

describe('readSessionTitleOverlay', () => {
  it('reports a directory that opens fine and has nothing in it as available with an empty map', () => {
    const result = readSessionTitleOverlay('/state', {
      readDirectory: () => [],
    });

    expect(result.declared).toEqual({
      available: true,
      annotations: new Map(),
    });
    expect(result.generated).toEqual({
      available: true,
      annotations: new Map(),
    });
  });

  it('tracks availability per directory: a missing native-titles/ (no Codex on this host) must not mark session-metadata/ unavailable', () => {
    const result = readSessionTitleOverlay('/state', {
      readDirectory: (directory) => {
        if (directory.endsWith('native-titles')) {
          throw new Error('ENOENT');
        }
        return [entry('session-title-1.json')];
      },
      readFile: () => valid,
    });

    expect(result.declared.available).toBe(true);
    expect(result.declared.annotations.get('session-title-1')).toMatchObject({
      title: 'Annotated title',
    });
    expect(result.generated).toEqual({
      available: false,
      annotations: new Map(),
    });
  });

  it('marks a directory unavailable when it overflows the file-count bound, independently of its sibling', () => {
    const result = readSessionTitleOverlay('/state', {
      readDirectory: (directory) =>
        directory.endsWith('session-metadata')
          ? Array.from(
              { length: MAX_SESSION_TITLE_ANNOTATION_FILES + 1 },
              (_, index) => entry(`session-${index}.json`),
            )
          : [],
    });

    expect(result.declared).toEqual({
      available: false,
      annotations: new Map(),
    });
    expect(result.generated).toEqual({
      available: true,
      annotations: new Map(),
    });
  });

  it('reads a malformed sibling file as skipped without marking its directory unavailable', () => {
    const result = readSessionTitleOverlay('/state', {
      readDirectory: () => [
        entry('broken.json'),
        entry('session-title-1.json'),
      ],
      readFile: (filePath) =>
        filePath.endsWith('broken.json') ? '{partial' : valid,
    });

    expect(result.declared.available).toBe(true);
    expect(result.declared.annotations).toEqual(
      new Map([
        [
          'session-title-1',
          {
            version: 1,
            sessionId: 'session-title-1',
            updatedAt: '2026-08-15T10:00:00.000Z',
            title: 'Annotated title',
          },
        ],
      ]),
    );
  });

  it('reads session-metadata/ and native-titles/ beneath the given state root', () => {
    const readDirectory = vi.fn(
      (
        _directory: string,
        _maxEntries: number,
      ): SessionTitleAnnotationDirectoryEntry[] => [],
    );
    readSessionTitleOverlay('/state', { readDirectory });

    const directories = readDirectory.mock.calls.map(
      ([directory]) => directory,
    );
    expect(directories).toContain('/state/session-metadata');
    expect(directories).toContain('/state/native-titles');
  });
});

describe('readSessionStatusAnnotations / readSessionStatusOverlay', () => {
  it('parses a valid status final, keyed by its own sessionId', () => {
    expect(
      readSessionStatusAnnotations('/annotations', {
        readDirectory: () => [entry('session-status-1.json')],
        readFile: () => validStatus,
      }),
    ).toEqual(
      new Map([
        [
          'session-status-1',
          {
            version: 1,
            sessionId: 'session-status-1',
            updatedAt: '2026-08-15T10:00:00.000Z',
            status: 'waiting on CI for #1247',
          },
        ],
      ]),
    );
  });

  it('rejects a title-shaped file (wrong field name) rather than parsing it as a status', () => {
    expect(
      readSessionStatusAnnotations('/annotations', {
        readDirectory: () => [entry('session-title-1.json')],
        readFile: () => valid,
      }),
    ).toEqual(new Map());
  });

  it('reports a directory that opens fine and has nothing in it as available with an empty map', () => {
    const result = readSessionStatusOverlay('/state', {
      readDirectory: () => [],
    });

    expect(result).toEqual({ available: true, annotations: new Map() });
  });

  it('reports a missing directory as unavailable', () => {
    const result = readSessionStatusOverlay('/state', {
      readDirectory: () => {
        throw new Error('ENOENT');
      },
    });

    expect(result).toEqual({ available: false, annotations: new Map() });
  });

  it('marks the directory unavailable when it overflows the file-count bound', () => {
    const result = readSessionStatusOverlay('/state', {
      readDirectory: () =>
        Array.from(
          { length: MAX_SESSION_TITLE_ANNOTATION_FILES + 1 },
          (_, index) => entry(`session-${index}.json`),
        ),
    });

    expect(result).toEqual({ available: false, annotations: new Map() });
  });

  it('skips a malformed sibling without marking the directory unavailable', () => {
    const result = readSessionStatusOverlay('/state', {
      readDirectory: () => [
        entry('broken.json'),
        entry('session-status-1.json'),
      ],
      readFile: (filePath) =>
        filePath.endsWith('broken.json') ? '{partial' : validStatus,
    });

    expect(result.available).toBe(true);
    expect(result.annotations.get('session-status-1')).toMatchObject({
      status: 'waiting on CI for #1247',
    });
  });

  it('reads session-status/ beneath the given state root', () => {
    const readDirectory = vi.fn(
      (
        _directory: string,
        _maxEntries: number,
      ): SessionTitleAnnotationDirectoryEntry[] => [],
    );
    readSessionStatusOverlay('/state', { readDirectory });

    expect(readDirectory.mock.calls.map(([directory]) => directory)).toEqual([
      '/state/session-status',
    ]);
  });

  it('reads a real valid status file end to end through the default readDirectory/readFile', () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'session-status-annotation-'),
    );
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'session-real.json'),
        JSON.stringify({
          version: 1,
          sessionId: 'session-real',
          updatedAt: '2026-08-15T10:00:00.000Z',
          status: 'Real status',
        }),
      );

      const result = readSessionStatusAnnotations(tmpDir);

      expect(result.get('session-real')).toMatchObject({
        status: 'Real status',
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/**
 * The seam-based tests above never exercise the real `readDirectoryBounded`
 * (the `opendirSync` enumeration and its "return at most `maxEntries + 1`"
 * overflow signal) or the real `readFileBounded` (the `O_NOFOLLOW` open, the
 * `fstat`-isFile recheck, the byte-cap comparison) beyond one narrow
 * `/dev/null` case. Every behaviour this module exists to provide is a real
 * filesystem interaction, so these run the DEFAULT dependencies — no
 * `readDirectory`/`readFile` overrides — against a real temp directory tree.
 */
describe('readSessionTitleAnnotations / readSessionTitleOverlay — real filesystem', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'session-title-annotation-'),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAnnotation(
    directory: string,
    filename: string,
    sessionId: string,
    title: string,
  ): void {
    fs.writeFileSync(
      path.join(directory, filename),
      JSON.stringify({
        version: 1,
        sessionId,
        updatedAt: '2026-08-15T10:00:00.000Z',
        title,
      }),
    );
  }

  it('reads one real valid file end to end through the default readDirectory/readFile', () => {
    writeAnnotation(tmpDir, 'session-real.json', 'session-real', 'Real title');

    const result = readSessionTitleAnnotations(tmpDir);

    expect(result).toEqual(
      new Map([
        [
          'session-real',
          {
            version: 1,
            sessionId: 'session-real',
            updatedAt: '2026-08-15T10:00:00.000Z',
            title: 'Real title',
          },
        ],
      ]),
    );
  });

  it('does not overflow at exactly MAX_SESSION_TITLE_ANNOTATION_FILES real files, but does at one more', () => {
    for (let i = 0; i < MAX_SESSION_TITLE_ANNOTATION_FILES; i++) {
      writeAnnotation(
        tmpDir,
        `session-${i}.json`,
        `session-${i}`,
        `Title ${i}`,
      );
    }

    const atBound = readSessionTitleAnnotations(tmpDir);
    expect(atBound.size).toBe(MAX_SESSION_TITLE_ANNOTATION_FILES);
    expect(atBound.get('session-0')).toMatchObject({ title: 'Title 0' });

    writeAnnotation(
      tmpDir,
      `session-${MAX_SESSION_TITLE_ANNOTATION_FILES}.json`,
      `session-${MAX_SESSION_TITLE_ANNOTATION_FILES}`,
      'One too many',
    );

    // Overflow fails the whole directory closed — not just dropping the
    // (MAX+1)th file — so every previously-readable annotation disappears
    // too, not just the newest one.
    expect(readSessionTitleAnnotations(tmpDir)).toEqual(new Map());
  });

  it('skips a real symlink while still returning a real regular sibling', () => {
    writeAnnotation(tmpDir, 'session-real.json', 'session-real', 'Real title');
    // The symlink's target content deliberately agrees with the SYMLINK's
    // own filename-derived id (not the target file's), so that if the
    // symlink-skip were ever removed, this file would parse as valid and
    // the test would catch it — a target/filename mismatch would hide that
    // regression instead of catching it.
    const targetPath = path.join(tmpDir, 'payload.data');
    fs.writeFileSync(
      targetPath,
      JSON.stringify({
        version: 1,
        sessionId: 'session-link',
        updatedAt: '2026-08-15T10:00:00.000Z',
        title: 'Should never appear',
      }),
    );
    fs.symlinkSync(targetPath, path.join(tmpDir, 'session-link.json'));

    const result = readSessionTitleAnnotations(tmpDir);

    expect(result.has('session-link')).toBe(false);
    expect(result.get('session-real')).toMatchObject({ title: 'Real title' });
  });

  it('skips a real file over MAX_SESSION_TITLE_ANNOTATION_BYTES while still returning a real valid sibling', () => {
    writeAnnotation(tmpDir, 'session-real.json', 'session-real', 'Real title');
    fs.writeFileSync(
      path.join(tmpDir, 'session-huge.json'),
      JSON.stringify({
        version: 1,
        sessionId: 'session-huge',
        updatedAt: '2026-08-15T10:00:00.000Z',
        title: 'x'.repeat(MAX_SESSION_TITLE_ANNOTATION_BYTES + 1),
      }),
    );

    const result = readSessionTitleAnnotations(tmpDir);

    expect(result.has('session-huge')).toBe(false);
    expect(result.get('session-real')).toMatchObject({ title: 'Real title' });
  });

  it('reads a real missing directory as unavailable and a real empty directory as available with nothing in it', () => {
    // Only `session-metadata/` exists (empty) — `native-titles/` is never
    // created, exactly like a real host with no Codex importer ever having
    // run. That must read as "nothing new," not "broken."
    fs.mkdirSync(path.join(tmpDir, 'session-metadata'));

    const result = readSessionTitleOverlay(tmpDir);

    expect(result.declared).toEqual({
      available: true,
      annotations: new Map(),
    });
    expect(result.generated).toEqual({
      available: false,
      annotations: new Map(),
    });
  });
});
