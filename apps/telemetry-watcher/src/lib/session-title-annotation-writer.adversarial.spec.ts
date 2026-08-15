import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSessionTitleAnnotation,
  SESSION_TITLE_ANNOTATION_DIRECTORY,
  SessionTitleAnnotationWriterFileSystem,
  writeSessionTitleAnnotation,
} from './session-title-annotation-writer';

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

function directory(homeDirectory: string): string {
  return path.join(homeDirectory, SESSION_TITLE_ANNOTATION_DIRECTORY);
}

function finalPath(homeDirectory: string, sessionId = SESSION_ID): string {
  return path.join(directory(homeDirectory), `${sessionId}.json`);
}

function deps(
  homeDirectory: string,
  fileSystem: Partial<SessionTitleAnnotationWriterFileSystem> = {},
) {
  return { homeDirectory, now: () => WHEN, fileSystem };
}

function readAnnotation(homeDirectory: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(finalPath(homeDirectory), 'utf8'),
  ) as Record<string, unknown>;
}

function readAnnotationAt(directoryPath: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(directoryPath, `${SESSION_ID}.json`), 'utf8'),
  ) as Record<string, unknown>;
}

function makeState(homeDirectory: string): void {
  fs.mkdirSync(directory(homeDirectory), { recursive: true, mode: 0o700 });
}

describe('session-title annotation writer adversarial durability', () => {
  it('writes exact v1 field order, mode 0600, and private directory mode 0700', () => {
    const homeDirectory = home();

    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        '  A   title\nwith irregular whitespace  ',
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
      writeSessionTitleAnnotation(SESSION_ID, rawTitle, deps(homeDirectory)),
    ).toEqual({ ok: true });
    expect(readAnnotation(homeDirectory).title).toBe(`${'x'.repeat(79)}…`);
  });

  it('repairs an existing directory mode through its descriptor', () => {
    const homeDirectory = home();
    makeState(homeDirectory);
    fs.chmodSync(directory(homeDirectory), 0o755);

    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        'private again',
        deps(homeDirectory),
      ),
    ).toEqual({ ok: true });
    expect(fs.statSync(directory(homeDirectory)).mode & 0o777).toBe(0o700);
  });

  it('replaces an existing final symlink itself without touching its target', () => {
    const homeDirectory = home();
    makeState(homeDirectory);
    const external = path.join(homeDirectory, 'external.json');
    fs.writeFileSync(external, 'external sentinel');
    fs.symlinkSync(external, finalPath(homeDirectory));

    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        'safe replacement',
        deps(homeDirectory),
      ),
    ).toEqual({ ok: true });
    expect(fs.readFileSync(external, 'utf8')).toBe('external sentinel');
    expect(fs.lstatSync(finalPath(homeDirectory)).isSymbolicLink()).toBe(false);
    expect(readAnnotation(homeDirectory).title).toBe('safe replacement');
  });

  it('refuses to clear a final symlink and never touches its target', () => {
    const homeDirectory = home();
    makeState(homeDirectory);
    const external = path.join(homeDirectory, 'external.json');
    fs.writeFileSync(external, 'must survive clear');
    fs.symlinkSync(external, finalPath(homeDirectory));

    expect(
      clearSessionTitleAnnotation(SESSION_ID, deps(homeDirectory)),
    ).toEqual({
      ok: false,
    });
    expect(fs.readFileSync(external, 'utf8')).toBe('must survive clear');
    expect(fs.lstatSync(finalPath(homeDirectory)).isSymbolicLink()).toBe(true);
  });

  it('never deletes a nonregular entry raced into place before clear captures it', () => {
    const homeDirectory = home();
    makeState(homeDirectory);
    fs.writeFileSync(finalPath(homeDirectory), 'old regular annotation');
    let replaced = false;
    const renameSync: SessionTitleAnnotationWriterFileSystem['renameSync'] = (
      from,
      to,
    ) => {
      if (
        !replaced &&
        String(from).endsWith(`/${SESSION_ID}.json`) &&
        String(to).endsWith('.clear.tmp')
      ) {
        replaced = true;
        fs.unlinkSync(from);
        execFileSync('mkfifo', [finalPath(homeDirectory)]);
      }
      fs.renameSync(from, to);
    };

    expect(
      clearSessionTitleAnnotation(SESSION_ID, {
        ...deps(homeDirectory, { renameSync }),
        randomBytes: () => Buffer.alloc(16, 0x33),
      }),
    ).toEqual({ ok: false });
    expect(replaced).toBe(true);
    expect(fs.lstatSync(finalPath(homeDirectory)).isFIFO()).toBe(true);
    expect(fs.readdirSync(directory(homeDirectory))).toEqual([
      `${SESSION_ID}.json`,
    ]);
  });

  it('does not delete a new final published after clear captures the old file', () => {
    const homeDirectory = home();
    makeState(homeDirectory);
    fs.writeFileSync(finalPath(homeDirectory), 'old regular annotation');
    let published = false;
    const lstatSync: SessionTitleAnnotationWriterFileSystem['lstatSync'] = (
      target,
    ) => {
      if (!published && String(target).endsWith('.clear.tmp')) {
        published = writeSessionTitleAnnotation(
          SESSION_ID,
          'new concurrent annotation',
          deps(homeDirectory),
        ).ok;
      }
      return fs.lstatSync(target);
    };

    expect(
      clearSessionTitleAnnotation(
        SESSION_ID,
        deps(homeDirectory, { lstatSync }),
      ),
    ).toEqual({ ok: true });
    expect(published).toBe(true);
    expect(readAnnotation(homeDirectory).title).toBe(
      'new concurrent annotation',
    );
  });

  it('treats an absent final as an idempotent clear and refuses nonregular finals', () => {
    const absentHome = home();
    makeState(absentHome);
    expect(clearSessionTitleAnnotation(SESSION_ID, deps(absentHome))).toEqual({
      ok: true,
    });

    const directoryHome = home();
    makeState(directoryHome);
    fs.mkdirSync(finalPath(directoryHome));
    expect(
      clearSessionTitleAnnotation(SESSION_ID, deps(directoryHome)),
    ).toEqual({ ok: false });
    expect(fs.statSync(finalPath(directoryHome)).isDirectory()).toBe(true);

    const fifoHome = home();
    makeState(fifoHome);
    execFileSync('mkfifo', [finalPath(fifoHome)]);
    expect(clearSessionTitleAnnotation(SESSION_ID, deps(fifoHome))).toEqual({
      ok: false,
    });
    expect(fs.statSync(finalPath(fifoHome)).isFIFO()).toBe(true);
  });

  it('rejects a symlinked state directory without touching the external directory', () => {
    const homeDirectory = home();
    const external = path.join(homeDirectory, 'external-state');
    fs.mkdirSync(external, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(external, 'attacker-sentinel'), 'untouched');
    const state = directory(homeDirectory);
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.symlinkSync(external, state);

    expect(
      writeSessionTitleAnnotation(SESSION_ID, 'must fail', deps(homeDirectory)),
    ).toEqual({
      ok: false,
    });
    expect(fs.readdirSync(external)).toEqual(['attacker-sentinel']);
    expect(
      fs.readFileSync(path.join(external, 'attacker-sentinel'), 'utf8'),
    ).toBe('untouched');
  });

  it('never sweeps a pre-existing stale temp, on either write or clear', () => {
    const homeDirectory = home();
    makeState(homeDirectory);
    const stale = path.join(directory(homeDirectory), '.other-writer.tmp');
    fs.writeFileSync(stale, 'harmless stale temp');

    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        'leave stale temp alone',
        deps(homeDirectory),
      ),
    ).toEqual({ ok: true });
    expect(fs.readFileSync(stale, 'utf8')).toBe('harmless stale temp');
    expect(
      clearSessionTitleAnnotation(SESSION_ID, deps(homeDirectory)),
    ).toEqual({ ok: true });
    expect(fs.readFileSync(stale, 'utf8')).toBe('harmless stale temp');
  });

  it.each(['', ' ../escape', '../escape', '-unsafe', 'unsafe/id', '_unsafe'])(
    'rejects unsafe writer and clear IDs without creating state (%j)',
    (sessionId) => {
      const homeDirectory = home();
      expect(
        writeSessionTitleAnnotation(
          sessionId,
          'must not write',
          deps(homeDirectory),
        ),
      ).toEqual({ ok: false });
      expect(
        clearSessionTitleAnnotation(sessionId, deps(homeDirectory)),
      ).toEqual({
        ok: false,
      });
      expect(
        fs.existsSync(
          path.join(homeDirectory, SESSION_TITLE_ANNOTATION_DIRECTORY),
        ),
      ).toBe(false);
    },
  );

  it('fails soft when the injected clock throws or returns an invalid Date', () => {
    const throwingHome = home();
    expect(() =>
      writeSessionTitleAnnotation(SESSION_ID, 'clock failure', {
        ...deps(throwingHome),
        now: () => {
          throw new Error('clock unavailable');
        },
      }),
    ).not.toThrow();
    expect(
      writeSessionTitleAnnotation(SESSION_ID, 'clock failure', {
        ...deps(throwingHome),
        now: () => new Date(Number.NaN),
      }),
    ).toEqual({ ok: false });
    expect(
      fs.existsSync(
        path.join(throwingHome, SESSION_TITLE_ANNOTATION_DIRECTORY),
      ),
    ).toBe(false);
  });

  it('pins the opened directory for writes when its pathname is replaced', () => {
    const homeDirectory = home();
    makeState(homeDirectory);
    const original = directory(homeDirectory);
    const moved = `${original}.moved`;
    const replacement = original;
    let opened = false;
    const openSync: SessionTitleAnnotationWriterFileSystem['openSync'] = (
      filePath,
      flags,
      mode,
    ) => {
      const descriptor = fs.openSync(filePath, flags, mode);
      if (filePath === original && !opened) {
        opened = true;
        fs.renameSync(original, moved);
        fs.mkdirSync(replacement, { mode: 0o700 });
        fs.writeFileSync(
          path.join(replacement, 'attacker-sentinel'),
          'untouched',
        );
      }
      return descriptor;
    };

    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        'pinned write',
        deps(homeDirectory, { openSync }),
      ),
    ).toEqual({ ok: true });
    expect(readAnnotationAt(moved)).toEqual(
      expect.objectContaining({ title: 'pinned write' }),
    );
    expect(fs.existsSync(path.join(replacement, `${SESSION_ID}.json`))).toBe(
      false,
    );
    expect(
      fs.readFileSync(path.join(replacement, 'attacker-sentinel'), 'utf8'),
    ).toBe('untouched');
  });

  it('pins the opened directory for clear when its pathname is replaced', () => {
    const homeDirectory = home();
    makeState(homeDirectory);
    fs.writeFileSync(finalPath(homeDirectory), 'old');
    const original = directory(homeDirectory);
    const moved = `${original}.moved`;
    let opened = false;
    const openSync: SessionTitleAnnotationWriterFileSystem['openSync'] = (
      filePath,
      flags,
      mode,
    ) => {
      const descriptor = fs.openSync(filePath, flags, mode);
      if (filePath === original && !opened) {
        opened = true;
        fs.renameSync(original, moved);
        fs.mkdirSync(original, { mode: 0o700 });
        fs.writeFileSync(path.join(original, 'attacker-sentinel'), 'untouched');
      }
      return descriptor;
    };

    expect(
      clearSessionTitleAnnotation(
        SESSION_ID,
        deps(homeDirectory, { openSync }),
      ),
    ).toEqual({
      ok: true,
    });
    expect(fs.existsSync(finalPath(homeDirectory))).toBe(false);
    expect(fs.existsSync(path.join(moved, `${SESSION_ID}.json`))).toBe(false);
    expect(
      fs.readFileSync(path.join(original, 'attacker-sentinel'), 'utf8'),
    ).toBe('untouched');
  });

  it.each([
    ['directory open failure', 'openSync'],
    ['write failure', 'writeSync'],
    ['temp fsync failure', 'fsyncSync'],
    ['temp close failure', 'closeSync'],
    ['rename failure', 'renameSync'],
  ] as const)(
    'preserves the old final and removes only its temp on pre-rename %s',
    (_label, operation) => {
      const homeDirectory = home();
      makeState(homeDirectory);
      fs.writeFileSync(finalPath(homeDirectory), 'complete old value');
      const randomBytes = () => Buffer.alloc(16, 0x42);
      const fileSystem = {
        [operation]: (() => {
          throw new Error(`${operation} failed`);
        }) as SessionTitleAnnotationWriterFileSystem[typeof operation],
      } as Partial<SessionTitleAnnotationWriterFileSystem>;

      expect(
        writeSessionTitleAnnotation(SESSION_ID, 'new value must not publish', {
          ...deps(homeDirectory, fileSystem),
          randomBytes,
        }),
      ).toEqual({ ok: false });
      expect(fs.readFileSync(finalPath(homeDirectory), 'utf8')).toBe(
        'complete old value',
      );
      expect(fs.readdirSync(directory(homeDirectory))).toEqual([
        `${SESSION_ID}.json`,
      ]);
    },
  );

  it('rejects a zero-byte write and terminates without publishing or leaking a temp', () => {
    const homeDirectory = home();
    makeState(homeDirectory);
    fs.writeFileSync(finalPath(homeDirectory), 'complete old value');
    const writeSync: SessionTitleAnnotationWriterFileSystem['writeSync'] = () =>
      0;

    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        'must not publish',
        deps(homeDirectory, { writeSync }),
      ),
    ).toEqual({ ok: false });
    expect(fs.readFileSync(finalPath(homeDirectory), 'utf8')).toBe(
      'complete old value',
    );
    expect(fs.readdirSync(directory(homeDirectory))).toEqual([
      `${SESSION_ID}.json`,
    ]);
  });

  it('handles partial writes until the complete buffer is durable', () => {
    const homeDirectory = home();
    let calls = 0;
    const writeSync: SessionTitleAnnotationWriterFileSystem['writeSync'] = (
      fd,
      buffer,
      offset,
      length,
      position,
    ) => {
      calls += 1;
      const available = length ?? buffer.byteLength - offset;
      return fs.writeSync(fd, buffer, offset, Math.min(available, 3), position);
    };

    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        'partial writes are retried',
        deps(homeDirectory, { writeSync }),
      ),
    ).toEqual({ ok: true });
    expect(calls).toBeGreaterThan(1);
    expect(readAnnotation(homeDirectory)).toEqual({
      version: 1,
      sessionId: SESSION_ID,
      updatedAt: WHEN.toISOString(),
      title: 'partial writes are retried',
    });
  });

  it('does not roll back a complete rename when directory fsync fails afterward', () => {
    const homeDirectory = home();
    let fsyncs = 0;
    const fsyncSync: SessionTitleAnnotationWriterFileSystem['fsyncSync'] = (
      fd,
    ) => {
      fsyncs += 1;
      if (fsyncs === 2) throw new Error('directory fsync failed');
      return fs.fsyncSync(fd);
    };

    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        'rename already happened',
        deps(homeDirectory, { fsyncSync }),
      ),
    ).toEqual({ ok: false });
    expect(readAnnotation(homeDirectory).title).toBe('rename already happened');
  });

  it('fails closed when the procfd capability is missing', () => {
    const homeDirectory = home();
    const statSync: SessionTitleAnnotationWriterFileSystem['statSync'] = () => {
      throw new Error('procfd missing');
    };
    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        'not written',
        deps(homeDirectory, { statSync }),
      ),
    ).toEqual({ ok: false });
    expect(fs.existsSync(directory(homeDirectory))).toBe(true);
    expect(fs.readdirSync(directory(homeDirectory))).toEqual([]);
  });

  it('fails closed when an individual durability primitive is absent', () => {
    const homeDirectory = home();
    const fsyncSync =
      undefined as unknown as SessionTitleAnnotationWriterFileSystem['fsyncSync'];
    expect(
      writeSessionTitleAnnotation(
        SESSION_ID,
        'missing fsync must not publish',
        deps(homeDirectory, { fsyncSync }),
      ),
    ).toEqual({ ok: false });
    expect(fs.readdirSync(directory(homeDirectory))).toEqual([]);
  });

  it('fails closed when Linux-only primitives are unavailable', () => {
    const homeDirectory = home();
    expect(
      writeSessionTitleAnnotation(SESSION_ID, 'not written', {
        ...deps(homeDirectory),
        platform: 'darwin',
      }),
    ).toEqual({ ok: false });
    expect(fs.existsSync(directory(homeDirectory))).toBe(false);
  });

  it('rejects a non-directory state path and a FIFO without following either', () => {
    const fileHome = home();
    const state = directory(fileHome);
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, 'not a directory');
    expect(
      writeSessionTitleAnnotation(SESSION_ID, 'nope', deps(fileHome)),
    ).toEqual({
      ok: false,
    });

    const fifoHome = home();
    const fifo = directory(fifoHome);
    fs.mkdirSync(path.dirname(fifo), { recursive: true });
    fs.mkdtempSync(path.join(os.tmpdir(), 'unused-'));
    // Linux's mkfifo is used only to construct the hostile fixture; O_DIRECTORY
    // must reject it before a blocking open can occur.
    execFileSync('mkfifo', [fifo]);
    expect(
      writeSessionTitleAnnotation(SESSION_ID, 'nope', deps(fifoHome)),
    ).toEqual({
      ok: false,
    });
  });

  it('keeps concurrent same-session writers complete and uses unique temporary names', () => {
    const homeDirectory = home();
    let random = 0;
    const randomBytes = () => Buffer.alloc(16, ++random);
    for (let index = 0; index < 20; index += 1) {
      expect(
        writeSessionTitleAnnotation(SESSION_ID, `complete-${index}`, {
          ...deps(homeDirectory),
          randomBytes,
        }),
      ).toEqual({ ok: true });
      expect(() => readAnnotation(homeDirectory)).not.toThrow();
    }
    expect(fs.readdirSync(directory(homeDirectory))).toEqual([
      `${SESSION_ID}.json`,
    ]);
  });

  it('keeps a deterministic same-ID writer interleaving tear-free', () => {
    const homeDirectory = home();
    let nested = false;
    let nestedResult = false;
    const renameSync: SessionTitleAnnotationWriterFileSystem['renameSync'] = (
      from,
      to,
    ) => {
      if (!nested) {
        nested = true;
        nestedResult = writeSessionTitleAnnotation(
          SESSION_ID,
          'nested complete writer',
          {
            ...deps(homeDirectory),
            randomBytes: () => Buffer.alloc(16, 0x22),
          },
        ).ok;
      }
      return fs.renameSync(from, to);
    };

    expect(
      writeSessionTitleAnnotation(SESSION_ID, 'outer complete writer', {
        ...deps(homeDirectory),
        randomBytes: () => Buffer.alloc(16, 0x11),
        fileSystem: { renameSync },
      }),
    ).toEqual({ ok: true });
    expect(nestedResult).toBe(true);
    expect(readAnnotation(homeDirectory)).toMatchObject({
      sessionId: SESSION_ID,
      title: 'outer complete writer',
    });
    expect(() => readAnnotation(homeDirectory)).not.toThrow();
    expect(fs.readdirSync(directory(homeDirectory))).toEqual([
      `${SESSION_ID}.json`,
    ]);
  });

  it('keeps a clear/write interleaving tear-free (absent or complete final)', () => {
    const homeDirectory = home();
    makeState(homeDirectory);
    fs.writeFileSync(finalPath(homeDirectory), 'old complete value');
    let nested = false;
    let nestedResult = false;
    const renameSync: SessionTitleAnnotationWriterFileSystem['renameSync'] = (
      from,
      to,
    ) => {
      if (
        String(from).endsWith(`/${SESSION_ID}.json`) &&
        String(to).endsWith('.clear.tmp') &&
        !nested
      ) {
        nested = true;
        nestedResult = writeSessionTitleAnnotation(
          SESSION_ID,
          'write racing clear',
          deps(homeDirectory),
        ).ok;
      }
      return fs.renameSync(from, to);
    };

    expect(
      clearSessionTitleAnnotation(
        SESSION_ID,
        deps(homeDirectory, { renameSync }),
      ),
    ).toEqual({ ok: true });
    expect(nestedResult).toBe(true);
    const final = fs.existsSync(finalPath(homeDirectory))
      ? readAnnotation(homeDirectory)
      : undefined;
    expect(final === undefined || typeof final.title === 'string').toBe(true);
  });
});
