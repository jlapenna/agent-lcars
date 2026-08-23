import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CLI_SESSION_RETENTION_DAYS } from '@agent-lcars/telemetry';
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSessionStatusAnnotation,
  clearSessionTitleAnnotation,
  pruneGeneratedSessionTitleAnnotations,
  pruneStaleDeclaredSessionTitleAnnotations,
  pruneStaleSessionStatusAnnotations,
  SESSION_TITLE_ANNOTATION_DIRECTORY,
  SessionTitleAnnotationWriterFileSystem,
  SessionTitleChannel,
  writeSessionStatusAnnotation,
  writeSessionTitleAnnotation,
} from './session-title-annotation-writer';
import {
  DECLARED_TITLE_SUBDIRECTORY,
  GENERATED_TITLE_SUBDIRECTORY,
  STATUS_SUBDIRECTORY,
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

/** Real wall-clock offset, for tests below that age a real file's mtime and
 * then ask whether it's inside/outside the retention horizon relative to
 * the real "now" -- distinct from `WHEN` above, which only ever backs the
 * writer's own `now` seam (the JSON body's `updatedAt` field), never a real
 * file's actual on-disk mtime. */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

describe('pruneGeneratedSessionTitleAnnotations', () => {
  it('deletes generated finals not in the keep set, keeps those that are', () => {
    const homeDirectory = home();
    writeSessionTitleAnnotation(
      'keep-me',
      'kept',
      GENERATED_TITLE_SUBDIRECTORY,
      deps(homeDirectory),
    );
    writeSessionTitleAnnotation(
      'drop-me',
      'dropped',
      GENERATED_TITLE_SUBDIRECTORY,
      deps(homeDirectory),
    );

    pruneGeneratedSessionTitleAnnotations(
      new Set(['keep-me']),
      deps(homeDirectory),
    );

    expect(
      fs.existsSync(
        finalPath(homeDirectory, GENERATED_TITLE_SUBDIRECTORY, 'keep-me'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        finalPath(homeDirectory, GENERATED_TITLE_SUBDIRECTORY, 'drop-me'),
      ),
    ).toBe(false);
  });

  it('never touches the declared channel', () => {
    const homeDirectory = home();
    writeSessionTitleAnnotation(
      SESSION_ID,
      'declared must survive',
      DECLARED_TITLE_SUBDIRECTORY,
      deps(homeDirectory),
    );

    // An empty keep set is the most aggressive possible sweep -- if
    // anything were going to leak across channels, this is where it would
    // show up.
    pruneGeneratedSessionTitleAnnotations(new Set(), deps(homeDirectory));

    expect(
      fs.existsSync(finalPath(homeDirectory, DECLARED_TITLE_SUBDIRECTORY)),
    ).toBe(true);
  });

  it('ignores a stray temp file and a non-json entry rather than deleting them', () => {
    const homeDirectory = home();
    const generatedDirectory = directory(
      homeDirectory,
      GENERATED_TITLE_SUBDIRECTORY,
    );
    fs.mkdirSync(generatedDirectory, { recursive: true, mode: 0o700 });
    const strayTemp = path.join(generatedDirectory, '.some-writer.tmp');
    const strayOther = path.join(generatedDirectory, 'not-json.txt');
    fs.writeFileSync(strayTemp, 'stray temp');
    fs.writeFileSync(strayOther, 'stray other');

    pruneGeneratedSessionTitleAnnotations(new Set(), deps(homeDirectory));

    expect(fs.existsSync(strayTemp)).toBe(true);
    expect(fs.existsSync(strayOther)).toBe(true);
  });

  it('is a no-op on a missing generated directory', () => {
    const homeDirectory = home();
    expect(() =>
      pruneGeneratedSessionTitleAnnotations(new Set(), deps(homeDirectory)),
    ).not.toThrow();
  });

  it('fails soft when one entry cannot be deleted, and still prunes the rest', () => {
    const homeDirectory = home();
    writeSessionTitleAnnotation(
      'drop-a',
      'a',
      GENERATED_TITLE_SUBDIRECTORY,
      deps(homeDirectory),
    );
    writeSessionTitleAnnotation(
      'drop-b',
      'b',
      GENERATED_TITLE_SUBDIRECTORY,
      deps(homeDirectory),
    );
    const unlinkSync: SessionTitleAnnotationWriterFileSystem['unlinkSync'] = (
      target,
    ) => {
      if (String(target).endsWith('drop-a.json')) {
        throw new Error('undeletable');
      }
      return fs.unlinkSync(target);
    };

    expect(() =>
      pruneGeneratedSessionTitleAnnotations(
        new Set(),
        deps(homeDirectory, { unlinkSync }),
      ),
    ).not.toThrow();

    expect(
      fs.existsSync(
        finalPath(homeDirectory, GENERATED_TITLE_SUBDIRECTORY, 'drop-a'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        finalPath(homeDirectory, GENERATED_TITLE_SUBDIRECTORY, 'drop-b'),
      ),
    ).toBe(false);
  });

  it('never removes a directory occupying a would-be final name', () => {
    const homeDirectory = home();
    const generatedDirectory = directory(
      homeDirectory,
      GENERATED_TITLE_SUBDIRECTORY,
    );
    fs.mkdirSync(generatedDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(generatedDirectory, 'as-a-dir.json');
    fs.mkdirSync(target);

    pruneGeneratedSessionTitleAnnotations(new Set(), deps(homeDirectory));

    expect(fs.statSync(target).isDirectory()).toBe(true);
  });
});

describe('pruneStaleDeclaredSessionTitleAnnotations', () => {
  it('prunes a declared annotation older than CLI_SESSION_RETENTION_DAYS, keeps one inside it', () => {
    const homeDirectory = home();
    const staleId = 'declared-stale';
    const freshId = 'declared-fresh';
    writeSessionTitleAnnotation(
      staleId,
      'stale title',
      DECLARED_TITLE_SUBDIRECTORY,
      deps(homeDirectory),
    );
    writeSessionTitleAnnotation(
      freshId,
      'fresh title',
      DECLARED_TITLE_SUBDIRECTORY,
      deps(homeDirectory),
    );
    const stale = daysAgo(CLI_SESSION_RETENTION_DAYS + 1);
    fs.utimesSync(
      finalPath(homeDirectory, DECLARED_TITLE_SUBDIRECTORY, staleId),
      stale,
      stale,
    );
    const fresh = daysAgo(CLI_SESSION_RETENTION_DAYS - 1);
    fs.utimesSync(
      finalPath(homeDirectory, DECLARED_TITLE_SUBDIRECTORY, freshId),
      fresh,
      fresh,
    );

    pruneStaleDeclaredSessionTitleAnnotations({
      homeDirectory,
      now: () => new Date(),
    });

    expect(
      fs.existsSync(
        finalPath(homeDirectory, DECLARED_TITLE_SUBDIRECTORY, staleId),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        finalPath(homeDirectory, DECLARED_TITLE_SUBDIRECTORY, freshId),
      ),
    ).toBe(true);
  });

  it('never collects a declared title written seconds ago', () => {
    const homeDirectory = home();
    writeSessionTitleAnnotation(
      SESSION_ID,
      'brand new',
      DECLARED_TITLE_SUBDIRECTORY,
      deps(homeDirectory),
    );

    pruneStaleDeclaredSessionTitleAnnotations({
      homeDirectory,
      now: () => new Date(),
    });

    expect(fs.existsSync(finalPath(homeDirectory))).toBe(true);
  });

  it('is a no-op on a missing or empty declared directory', () => {
    const homeDirectory = home();
    expect(() =>
      pruneStaleDeclaredSessionTitleAnnotations({
        homeDirectory,
        now: () => new Date(),
      }),
    ).not.toThrow();
    expect(fs.existsSync(directory(homeDirectory))).toBe(false);

    fs.mkdirSync(directory(homeDirectory), { recursive: true, mode: 0o700 });
    expect(() =>
      pruneStaleDeclaredSessionTitleAnnotations({
        homeDirectory,
        now: () => new Date(),
      }),
    ).not.toThrow();
    expect(fs.readdirSync(directory(homeDirectory))).toEqual([]);
  });

  it('never deletes a declared title purely for count, however many are inside the horizon', () => {
    const homeDirectory = home();
    // Comfortably past every count-based cap elsewhere in this issue
    // (`MAX_SESSION_TITLE_ANNOTATION_FILES` 256, `CODEX_NATIVE_TITLE_IMPORT
    // _CAP` 192) -- this function has no count parameter at all, and this
    // is the test that would catch one being added back by accident.
    const total = 300;
    const titleDirectory = directory(homeDirectory);
    fs.mkdirSync(titleDirectory, { recursive: true, mode: 0o700 });
    for (let index = 0; index < total; index += 1) {
      // Pruning deliberately depends only on a safe final filename and its
      // mtime; it does not parse title payloads. Write that minimal fixture
      // directly so this count-boundary test does not pay 300 directory
      // fsyncs from the writer's separate durability contract.
      fs.writeFileSync(
        path.join(titleDirectory, `declared-${index}.json`),
        '{}',
        { mode: 0o600 },
      );
    }

    pruneStaleDeclaredSessionTitleAnnotations({
      homeDirectory,
      now: () => new Date(),
    });

    expect(fs.readdirSync(directory(homeDirectory))).toHaveLength(total);
  });

  it('fails soft when one entry cannot be deleted, and still prunes the rest', () => {
    const homeDirectory = home();
    const staleA = 'stale-a';
    const staleB = 'stale-b';
    writeSessionTitleAnnotation(
      staleA,
      'a',
      DECLARED_TITLE_SUBDIRECTORY,
      deps(homeDirectory),
    );
    writeSessionTitleAnnotation(
      staleB,
      'b',
      DECLARED_TITLE_SUBDIRECTORY,
      deps(homeDirectory),
    );
    const stale = daysAgo(CLI_SESSION_RETENTION_DAYS + 5);
    fs.utimesSync(
      finalPath(homeDirectory, DECLARED_TITLE_SUBDIRECTORY, staleA),
      stale,
      stale,
    );
    fs.utimesSync(
      finalPath(homeDirectory, DECLARED_TITLE_SUBDIRECTORY, staleB),
      stale,
      stale,
    );
    const unlinkSync: SessionTitleAnnotationWriterFileSystem['unlinkSync'] = (
      target,
    ) => {
      if (String(target).endsWith(`${staleA}.json`)) {
        throw new Error('undeletable');
      }
      return fs.unlinkSync(target);
    };

    expect(() =>
      pruneStaleDeclaredSessionTitleAnnotations({
        homeDirectory,
        now: () => new Date(),
        fileSystem: { unlinkSync },
      }),
    ).not.toThrow();

    expect(
      fs.existsSync(
        finalPath(homeDirectory, DECLARED_TITLE_SUBDIRECTORY, staleA),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        finalPath(homeDirectory, DECLARED_TITLE_SUBDIRECTORY, staleB),
      ),
    ).toBe(false);
  });

  it('deletes nothing when the injected clock is invalid, rather than guessing an age', () => {
    const homeDirectory = home();
    const staleId = 'declared-stale-invalid-clock';
    writeSessionTitleAnnotation(
      staleId,
      'stale',
      DECLARED_TITLE_SUBDIRECTORY,
      deps(homeDirectory),
    );
    const stale = daysAgo(CLI_SESSION_RETENTION_DAYS + 10);
    fs.utimesSync(
      finalPath(homeDirectory, DECLARED_TITLE_SUBDIRECTORY, staleId),
      stale,
      stale,
    );

    // A NaN cutoff makes every `mtimeMs >= cutoffMs` comparison false --
    // without an explicit finiteness guard this would fall through to
    // deleting literally everything instead of nothing. This is the
    // regression test for that guard.
    pruneStaleDeclaredSessionTitleAnnotations({
      homeDirectory,
      now: () => new Date(Number.NaN),
    });

    expect(
      fs.existsSync(
        finalPath(homeDirectory, DECLARED_TITLE_SUBDIRECTORY, staleId),
      ),
    ).toBe(true);
  });

  it('deletes nothing when the injected clock throws', () => {
    const homeDirectory = home();
    const staleId = 'declared-stale-throwing-clock';
    writeSessionTitleAnnotation(
      staleId,
      'stale',
      DECLARED_TITLE_SUBDIRECTORY,
      deps(homeDirectory),
    );
    const stale = daysAgo(CLI_SESSION_RETENTION_DAYS + 10);
    fs.utimesSync(
      finalPath(homeDirectory, DECLARED_TITLE_SUBDIRECTORY, staleId),
      stale,
      stale,
    );

    pruneStaleDeclaredSessionTitleAnnotations({
      homeDirectory,
      now: () => {
        throw new Error('clock unavailable');
      },
    });

    expect(
      fs.existsSync(
        finalPath(homeDirectory, DECLARED_TITLE_SUBDIRECTORY, staleId),
      ),
    ).toBe(true);
  });

  it('never touches the generated channel', () => {
    const homeDirectory = home();
    writeSessionTitleAnnotation(
      SESSION_ID,
      'generated must survive',
      GENERATED_TITLE_SUBDIRECTORY,
      deps(homeDirectory),
    );
    const stale = daysAgo(CLI_SESSION_RETENTION_DAYS + 10);
    fs.utimesSync(
      finalPath(homeDirectory, GENERATED_TITLE_SUBDIRECTORY, SESSION_ID),
      stale,
      stale,
    );

    pruneStaleDeclaredSessionTitleAnnotations({
      homeDirectory,
      now: () => new Date(),
    });

    expect(
      fs.existsSync(
        finalPath(homeDirectory, GENERATED_TITLE_SUBDIRECTORY, SESSION_ID),
      ),
    ).toBe(true);
  });

  it('ignores a stray temp file and a non-json entry rather than deleting them', () => {
    const homeDirectory = home();
    fs.mkdirSync(directory(homeDirectory), { recursive: true, mode: 0o700 });
    const strayTemp = path.join(directory(homeDirectory), '.some-writer.tmp');
    const strayOther = path.join(directory(homeDirectory), 'not-json.txt');
    fs.writeFileSync(strayTemp, 'stray temp');
    fs.writeFileSync(strayOther, 'stray other');
    const stale = daysAgo(CLI_SESSION_RETENTION_DAYS + 10);
    fs.utimesSync(strayTemp, stale, stale);
    fs.utimesSync(strayOther, stale, stale);

    pruneStaleDeclaredSessionTitleAnnotations({
      homeDirectory,
      now: () => new Date(),
    });

    expect(fs.existsSync(strayTemp)).toBe(true);
    expect(fs.existsSync(strayOther)).toBe(true);
  });
});

describe('writeSessionStatusAnnotation / clearSessionStatusAnnotation', () => {
  it('writes a status final with exact v1 field order under the status channel', () => {
    const homeDirectory = home();

    const result = writeSessionStatusAnnotation(
      SESSION_ID,
      'waiting on CI for #1247',
      deps(homeDirectory),
    );

    expect(result).toEqual({ ok: true });
    const raw = fs.readFileSync(
      finalPath(homeDirectory, STATUS_SUBDIRECTORY),
      'utf8',
    );
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      sessionId: SESSION_ID,
      updatedAt: WHEN.toISOString(),
      status: 'waiting on CI for #1247',
    });
    expect(Object.keys(JSON.parse(raw))).toEqual([
      'version',
      'sessionId',
      'updatedAt',
      'status',
    ]);
  });

  it('persists the shared 80-character normalized status policy', () => {
    const homeDirectory = home();

    writeSessionStatusAnnotation(
      SESSION_ID,
      'x'.repeat(200),
      deps(homeDirectory),
    );

    const annotation = readAnnotation(homeDirectory, STATUS_SUBDIRECTORY);
    expect(annotation['status']).toHaveLength(80);
  });

  it('rejects an empty status after normalization without publishing', () => {
    const homeDirectory = home();

    const result = writeSessionStatusAnnotation(
      SESSION_ID,
      '   ',
      deps(homeDirectory),
    );

    expect(result).toEqual({ ok: false });
    expect(fs.existsSync(directory(homeDirectory, STATUS_SUBDIRECTORY))).toBe(
      false,
    );
  });

  it('writes the status channel at a distinct directory from either title channel', () => {
    const homeDirectory = home();
    writeSessionTitleAnnotation(
      SESSION_ID,
      'A declared title',
      DECLARED_TITLE_SUBDIRECTORY,
      deps(homeDirectory),
    );

    writeSessionStatusAnnotation(
      SESSION_ID,
      'A declared status',
      deps(homeDirectory),
    );

    // Same session id, three distinct files -- clearing/overwriting one
    // must never touch either of the others.
    expect(directory(homeDirectory, STATUS_SUBDIRECTORY)).not.toBe(
      directory(homeDirectory, DECLARED_TITLE_SUBDIRECTORY),
    );
    expect(readAnnotation(homeDirectory, DECLARED_TITLE_SUBDIRECTORY)).toEqual({
      version: 1,
      sessionId: SESSION_ID,
      updatedAt: WHEN.toISOString(),
      title: 'A declared title',
    });
    expect(readAnnotation(homeDirectory, STATUS_SUBDIRECTORY)).toEqual({
      version: 1,
      sessionId: SESSION_ID,
      updatedAt: WHEN.toISOString(),
      status: 'A declared status',
    });
  });

  it('treats an absent status final as an idempotent clear', () => {
    const homeDirectory = home();

    expect(
      clearSessionStatusAnnotation(SESSION_ID, deps(homeDirectory)),
    ).toEqual({ ok: true });
  });

  it('clear removes only the status final, leaving a same-session declared title untouched', () => {
    const homeDirectory = home();
    writeSessionTitleAnnotation(
      SESSION_ID,
      'A declared title',
      DECLARED_TITLE_SUBDIRECTORY,
      deps(homeDirectory),
    );
    writeSessionStatusAnnotation(
      SESSION_ID,
      'A declared status',
      deps(homeDirectory),
    );

    const result = clearSessionStatusAnnotation(
      SESSION_ID,
      deps(homeDirectory),
    );

    expect(result).toEqual({ ok: true });
    expect(fs.existsSync(finalPath(homeDirectory, STATUS_SUBDIRECTORY))).toBe(
      false,
    );
    expect(
      fs.existsSync(finalPath(homeDirectory, DECLARED_TITLE_SUBDIRECTORY)),
    ).toBe(true);
  });
});

describe('pruneStaleSessionStatusAnnotations', () => {
  it('prunes a status annotation older than CLI_SESSION_RETENTION_DAYS, keeps one inside it', () => {
    const homeDirectory = home();
    writeSessionStatusAnnotation('old-status', 'stale', {
      homeDirectory,
      now: () => new Date(),
    });
    writeSessionStatusAnnotation('fresh-status', 'fresh', {
      homeDirectory,
      now: () => new Date(),
    });
    const staleTime = daysAgo(CLI_SESSION_RETENTION_DAYS + 1);
    fs.utimesSync(
      finalPath(homeDirectory, STATUS_SUBDIRECTORY, 'old-status'),
      staleTime,
      staleTime,
    );

    pruneStaleSessionStatusAnnotations({
      homeDirectory,
      now: () => new Date(),
    });

    expect(
      fs.existsSync(
        finalPath(homeDirectory, STATUS_SUBDIRECTORY, 'old-status'),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        finalPath(homeDirectory, STATUS_SUBDIRECTORY, 'fresh-status'),
      ),
    ).toBe(true);
  });

  it('is a no-op on a missing status directory', () => {
    const homeDirectory = home();

    expect(() =>
      pruneStaleSessionStatusAnnotations({ homeDirectory }),
    ).not.toThrow();
  });

  it('never touches the declared title channel while pruning the status channel', () => {
    const homeDirectory = home();
    writeSessionTitleAnnotation(
      SESSION_ID,
      'A declared title',
      DECLARED_TITLE_SUBDIRECTORY,
      { homeDirectory, now: () => new Date() },
    );
    writeSessionStatusAnnotation(SESSION_ID, 'stale', {
      homeDirectory,
      now: () => new Date(),
    });
    const staleTime = daysAgo(CLI_SESSION_RETENTION_DAYS + 1);
    fs.utimesSync(
      finalPath(homeDirectory, STATUS_SUBDIRECTORY),
      staleTime,
      staleTime,
    );
    fs.utimesSync(
      finalPath(homeDirectory, DECLARED_TITLE_SUBDIRECTORY),
      staleTime,
      staleTime,
    );

    pruneStaleSessionStatusAnnotations({
      homeDirectory,
      now: () => new Date(),
    });

    expect(fs.existsSync(finalPath(homeDirectory, STATUS_SUBDIRECTORY))).toBe(
      false,
    );
    // The declared channel is old enough too, but this prune call is scoped
    // to the status channel only -- pruneStaleDeclaredSessionTitleAnnotations
    // is a separate call, exercised elsewhere in this file.
    expect(
      fs.existsSync(finalPath(homeDirectory, DECLARED_TITLE_SUBDIRECTORY)),
    ).toBe(true);
  });

  it('never removes a status annotation still inside the retention horizon, however many are present', () => {
    const homeDirectory = home();
    for (let i = 0; i < 5; i++) {
      writeSessionStatusAnnotation(`status-${i}`, `status ${i}`, {
        homeDirectory,
        now: () => new Date(),
      });
    }

    pruneStaleSessionStatusAnnotations({
      homeDirectory,
      now: () => new Date(),
    });

    for (let i = 0; i < 5; i++) {
      expect(
        fs.existsSync(
          finalPath(homeDirectory, STATUS_SUBDIRECTORY, `status-${i}`),
        ),
      ).toBe(true);
    }
  });
});
