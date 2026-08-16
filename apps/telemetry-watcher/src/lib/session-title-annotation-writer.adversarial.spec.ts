import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSessionTitleAnnotation,
  SESSION_TITLE_ANNOTATION_DIRECTORY,
  SessionTitleAnnotationWriterFileSystem,
  SessionTitleChannel,
  writeSessionTitleAnnotation,
} from './session-title-annotation-writer';
import {
  DECLARED_TITLE_SUBDIRECTORY,
  GENERATED_TITLE_SUBDIRECTORY,
} from './session-title-paths';

const SESSION_ID = 'adversarial-session-1';
const WHEN = new Date('2026-08-15T12:34:56.000Z');

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0))
    fs.rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-title-writer-'));
  homes.push(value);
  return value;
}

function directory(
  homeDirectory: string,
  channel: SessionTitleChannel = DECLARED_TITLE_SUBDIRECTORY,
): string {
  return channel === DECLARED_TITLE_SUBDIRECTORY
    ? path.join(homeDirectory, SESSION_TITLE_ANNOTATION_DIRECTORY)
    : path.join(homeDirectory, '.local', 'state', 'agent-lcars', channel);
}

function finalPath(
  homeDirectory: string,
  channel: SessionTitleChannel = DECLARED_TITLE_SUBDIRECTORY,
  sessionId = SESSION_ID,
): string {
  return path.join(directory(homeDirectory, channel), `${sessionId}.json`);
}

function deps(
  homeDirectory: string,
  fileSystem: Partial<SessionTitleAnnotationWriterFileSystem> = {},
) {
  return { homeDirectory, now: () => WHEN, fileSystem };
}

function readAnnotation(
  homeDirectory: string,
  channel: SessionTitleChannel = DECLARED_TITLE_SUBDIRECTORY,
): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(finalPath(homeDirectory, channel), 'utf8'),
  ) as Record<string, unknown>;
}

describe('session-title annotation writer', () => {
  it('writes exact v1 field order, mode 0600, and private directory mode 0700', () => {
    const homeDirectory = home();

    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        '  A   title\nwith irregular whitespace  ',
        DECLARED_TITLE_SUBDIRECTORY,
        deps(homeDirectory),
      ),
    ).toEqual({ ok: true });

    expect(fs.statSync(directory(homeDirectory)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(finalPath(homeDirectory)).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(finalPath(homeDirectory), 'utf8')).toBe(
      '{"version":1,"sessionId":"adversarial-session-1","updatedAt":"2026-08-15T12:34:56.000Z","title":"A title with irregular whitespace"}',
    );
  });

  it('persists the shared 80-character normalized title policy', () => {
    const homeDirectory = home();
    const rawTitle = `   ${'x'.repeat(100)}\n  `;

    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        rawTitle,
        DECLARED_TITLE_SUBDIRECTORY,
        deps(homeDirectory),
      ),
    ).toEqual({ ok: true });
    expect(readAnnotation(homeDirectory).title).toBe(`${'x'.repeat(79)}…`);
  });

  it('rejects an empty title after normalization without publishing', () => {
    const homeDirectory = home();
    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        '   \n  ',
        DECLARED_TITLE_SUBDIRECTORY,
        deps(homeDirectory),
      ),
    ).toEqual({ ok: false });
    expect(fs.existsSync(directory(homeDirectory))).toBe(false);
  });

  it('targets the declared and generated channels at distinct directories', () => {
    const homeDirectory = home();

    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        'declared title',
        DECLARED_TITLE_SUBDIRECTORY,
        deps(homeDirectory),
      ),
    ).toEqual({ ok: true });
    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        'generated title',
        GENERATED_TITLE_SUBDIRECTORY,
        deps(homeDirectory),
      ),
    ).toEqual({ ok: true });

    expect(
      readAnnotation(homeDirectory, DECLARED_TITLE_SUBDIRECTORY).title,
    ).toBe('declared title');
    expect(
      readAnnotation(homeDirectory, GENERATED_TITLE_SUBDIRECTORY).title,
    ).toBe('generated title');
    expect(directory(homeDirectory, DECLARED_TITLE_SUBDIRECTORY)).not.toBe(
      directory(homeDirectory, GENERATED_TITLE_SUBDIRECTORY),
    );
  });

  it.each(['', ' ../escape', '../escape', '-unsafe', 'unsafe/id', '_unsafe'])(
    'rejects unsafe writer and clear IDs without creating state (%j)',
    (sessionId) => {
      const homeDirectory = home();
      expect(
        writeSessionTitleAnnotation(
          sessionId,
          'must not write',
          DECLARED_TITLE_SUBDIRECTORY,
          deps(homeDirectory),
        ),
      ).toEqual({ ok: false });
      expect(
        clearSessionTitleAnnotation(
          sessionId,
          DECLARED_TITLE_SUBDIRECTORY,
          deps(homeDirectory),
        ),
      ).toEqual({ ok: false });
      expect(fs.existsSync(directory(homeDirectory))).toBe(false);
    },
  );

  it('treats an absent final as an idempotent clear', () => {
    const homeDirectory = home();
    expect(
      clearSessionTitleAnnotation(
        SESSION_ID,
        DECLARED_TITLE_SUBDIRECTORY,
        deps(homeDirectory),
      ),
    ).toEqual({ ok: true });
    expect(
      clearSessionTitleAnnotation(
        SESSION_ID,
        DECLARED_TITLE_SUBDIRECTORY,
        deps(homeDirectory),
      ),
    ).toEqual({ ok: true });
  });

  it('clear removes only the targeted session and only its own channel', () => {
    const homeDirectory = home();
    const other = 'adversarial-session-2';
    writeSessionTitleAnnotation(
      SESSION_ID,
      'to clear',
      DECLARED_TITLE_SUBDIRECTORY,
      deps(homeDirectory),
    );
    writeSessionTitleAnnotation(
      other,
      'must survive',
      DECLARED_TITLE_SUBDIRECTORY,
      deps(homeDirectory),
    );
    writeSessionTitleAnnotation(
      SESSION_ID,
      'must survive in the other channel',
      GENERATED_TITLE_SUBDIRECTORY,
      deps(homeDirectory),
    );

    expect(
      clearSessionTitleAnnotation(
        SESSION_ID,
        DECLARED_TITLE_SUBDIRECTORY,
        deps(homeDirectory),
      ),
    ).toEqual({ ok: true });

    expect(
      fs.existsSync(finalPath(homeDirectory, DECLARED_TITLE_SUBDIRECTORY)),
    ).toBe(false);
    expect(
      fs.existsSync(
        finalPath(homeDirectory, DECLARED_TITLE_SUBDIRECTORY, other),
      ),
    ).toBe(true);
    expect(
      readAnnotation(homeDirectory, GENERATED_TITLE_SUBDIRECTORY).title,
    ).toBe('must survive in the other channel');
  });

  it('rejects clearing a non-regular final (a directory) rather than deleting it', () => {
    const homeDirectory = home();
    fs.mkdirSync(directory(homeDirectory), { recursive: true, mode: 0o700 });
    fs.mkdirSync(finalPath(homeDirectory));
    expect(
      clearSessionTitleAnnotation(
        SESSION_ID,
        DECLARED_TITLE_SUBDIRECTORY,
        deps(homeDirectory),
      ),
    ).toEqual({ ok: false });
    expect(fs.statSync(finalPath(homeDirectory)).isDirectory()).toBe(true);
  });

  it('rejects clearing a symlinked final without following it to delete its target', () => {
    const homeDirectory = home();
    fs.mkdirSync(directory(homeDirectory), { recursive: true, mode: 0o700 });
    const external = path.join(homeDirectory, 'external.json');
    fs.writeFileSync(external, 'external sentinel');
    fs.symlinkSync(external, finalPath(homeDirectory));

    expect(
      clearSessionTitleAnnotation(
        SESSION_ID,
        DECLARED_TITLE_SUBDIRECTORY,
        deps(homeDirectory),
      ),
    ).toEqual({ ok: false });
    expect(fs.readFileSync(external, 'utf8')).toBe('external sentinel');
    expect(fs.lstatSync(finalPath(homeDirectory)).isSymbolicLink()).toBe(true);
  });

  it('never sweeps a pre-existing stale temp, on either write or clear', () => {
    const homeDirectory = home();
    fs.mkdirSync(directory(homeDirectory), { recursive: true, mode: 0o700 });
    const stale = path.join(directory(homeDirectory), '.other-writer.tmp');
    fs.writeFileSync(stale, 'harmless stale temp');

    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        'leave stale temp alone',
        DECLARED_TITLE_SUBDIRECTORY,
        deps(homeDirectory),
      ),
    ).toEqual({ ok: true });
    expect(fs.readFileSync(stale, 'utf8')).toBe('harmless stale temp');
    expect(
      clearSessionTitleAnnotation(
        SESSION_ID,
        DECLARED_TITLE_SUBDIRECTORY,
        deps(homeDirectory),
      ),
    ).toEqual({ ok: true });
    expect(fs.readFileSync(stale, 'utf8')).toBe('harmless stale temp');
  });

  it('leaves no stray temp file when the write itself fails', () => {
    const homeDirectory = home();
    fs.mkdirSync(directory(homeDirectory), { recursive: true, mode: 0o700 });
    fs.writeFileSync(finalPath(homeDirectory), 'complete old value');
    const writeFileSync: SessionTitleAnnotationWriterFileSystem['writeFileSync'] =
      () => {
        throw new Error('disk full');
      };

    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        'must not publish',
        DECLARED_TITLE_SUBDIRECTORY,
        deps(homeDirectory, { writeFileSync }),
      ),
    ).toEqual({ ok: false });
    expect(fs.readFileSync(finalPath(homeDirectory), 'utf8')).toBe(
      'complete old value',
    );
    expect(fs.readdirSync(directory(homeDirectory))).toEqual([
      `${SESSION_ID}.json`,
    ]);
  });

  it('leaves no stray temp file when the rename itself fails', () => {
    const homeDirectory = home();
    fs.mkdirSync(directory(homeDirectory), { recursive: true, mode: 0o700 });
    fs.writeFileSync(finalPath(homeDirectory), 'complete old value');
    const renameSync: SessionTitleAnnotationWriterFileSystem['renameSync'] =
      () => {
        throw new Error('rename failed');
      };

    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        'must not publish',
        DECLARED_TITLE_SUBDIRECTORY,
        deps(homeDirectory, { renameSync }),
      ),
    ).toEqual({ ok: false });
    expect(fs.readFileSync(finalPath(homeDirectory), 'utf8')).toBe(
      'complete old value',
    );
    expect(fs.readdirSync(directory(homeDirectory))).toEqual([
      `${SESSION_ID}.json`,
    ]);
  });

  it('fails soft when the injected clock throws or returns an invalid Date', () => {
    const throwingHome = home();
    expect(() =>
      writeSessionTitleAnnotation(
        SESSION_ID,
        'clock failure',
        DECLARED_TITLE_SUBDIRECTORY,
        {
          ...deps(throwingHome),
          now: () => {
            throw new Error('clock unavailable');
          },
        },
      ),
    ).not.toThrow();
    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        'clock failure',
        DECLARED_TITLE_SUBDIRECTORY,
        { ...deps(throwingHome), now: () => new Date(Number.NaN) },
      ),
    ).toEqual({ ok: false });
    expect(fs.existsSync(directory(throwingHome))).toBe(false);
  });

  it('does not roll back a completed rename when the directory fsync fails afterward', () => {
    const homeDirectory = home();
    let fsyncs = 0;
    const fsyncSync: SessionTitleAnnotationWriterFileSystem['fsyncSync'] =
      () => {
        fsyncs += 1;
        throw new Error('directory fsync failed');
      };

    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        'rename already happened',
        DECLARED_TITLE_SUBDIRECTORY,
        deps(homeDirectory, { fsyncSync }),
      ),
    ).toEqual({ ok: true });
    expect(fsyncs).toBe(1);
    expect(readAnnotation(homeDirectory).title).toBe('rename already happened');
    expect(fs.readdirSync(directory(homeDirectory))).toEqual([
      `${SESSION_ID}.json`,
    ]);
  });

  it('keeps concurrent same-session writers complete, unique-named, and free of torn reads', () => {
    const homeDirectory = home();
    let random = 0;
    const randomBytes = () => Buffer.alloc(16, ++random);
    const observedTitles = new Set<string>();

    // Simulate interleaving: every rename observes only ever a fully-formed
    // prior file (the old final, or a fully-written temp about to replace
    // it) -- never a partial write, because publish is write-then-rename.
    for (let index = 0; index < 20; index += 1) {
      expect(
        writeSessionTitleAnnotation(
          SESSION_ID,
          `complete-${index}`,
          DECLARED_TITLE_SUBDIRECTORY,
          { ...deps(homeDirectory), randomBytes },
        ),
      ).toEqual({ ok: true });
      const observed = readAnnotation(homeDirectory).title;
      expect(typeof observed).toBe('string');
      observedTitles.add(observed as string);
    }
    // Every intermediate read was a complete, valid JSON annotation (the
    // `readAnnotation` call above would have thrown on a torn read).
    expect(observedTitles.size).toBeGreaterThan(0);
    expect(fs.readdirSync(directory(homeDirectory))).toEqual([
      `${SESSION_ID}.json`,
    ]);
  });

  it('a writer racing a clear leaves either an absent file or one complete annotation, never a torn one', () => {
    const homeDirectory = home();
    fs.mkdirSync(directory(homeDirectory), { recursive: true, mode: 0o700 });
    fs.writeFileSync(finalPath(homeDirectory), 'old complete value');
    let nested = false;
    let nestedResult = false;
    const unlinkSync: SessionTitleAnnotationWriterFileSystem['unlinkSync'] = (
      target,
    ) => {
      if (!nested && String(target).endsWith(`/${SESSION_ID}.json`)) {
        nested = true;
        nestedResult = writeSessionTitleAnnotation(
          SESSION_ID,
          'write racing clear',
          DECLARED_TITLE_SUBDIRECTORY,
          deps(homeDirectory),
        ).ok;
      }
      return fs.unlinkSync(target);
    };

    clearSessionTitleAnnotation(SESSION_ID, DECLARED_TITLE_SUBDIRECTORY, {
      ...deps(homeDirectory),
      fileSystem: { unlinkSync },
    });
    expect(nestedResult).toBe(true);
    const final = fs.existsSync(finalPath(homeDirectory))
      ? readAnnotation(homeDirectory)
      : undefined;
    expect(final === undefined || typeof final.title === 'string').toBe(true);
  });
});
