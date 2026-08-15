import { describe, expect, it, vi } from 'vitest';

import {
  MAX_SESSION_TITLE_ANNOTATION_BYTES,
  MAX_SESSION_TITLE_ANNOTATION_FILES,
  readSessionTitleAnnotations,
  SessionTitleAnnotationDirectoryEntry,
} from './session-title-annotation-source';

const valid = JSON.stringify({
  version: 1,
  sessionId: 'session-title-1',
  updatedAt: '2026-08-15T10:00:00.000Z',
  title: 'Annotated title',
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
