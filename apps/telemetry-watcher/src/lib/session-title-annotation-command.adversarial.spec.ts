import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { executeSessionTitleAnnotationCommand } from './session-title-annotation-command';
import { SESSION_TITLE_ANNOTATION_DIRECTORY } from './session-title-annotation-writer';

const SESSION_ID = 'command-session-1';
const TITLE = 'title must never be echoed in an error';
const homes: string[] = [];

afterEach(() => {
  delete process.env['LCARS_SESSION_ID'];
  for (const home of homes.splice(0))
    fs.rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-title-command-'));
  homes.push(value);
  return value;
}

function finalPath(homeDirectory: string): string {
  return path.join(
    homeDirectory,
    SESSION_TITLE_ANNOTATION_DIRECTORY,
    `${SESSION_ID}.json`,
  );
}

describe('session title command exact CLI grammar', () => {
  it('accepts only the full session title command and reads the ID from its env seam', () => {
    const homeDirectory = home();
    const result = executeSessionTitleAnnotationCommand(
      ['session', 'title', TITLE],
      {
        env: { LCARS_SESSION_ID: SESSION_ID },
        homeDirectory,
        now: () => new Date('2026-08-15T12:34:56.000Z'),
      },
    );

    expect(result).toEqual({ ok: true });
    expect(
      JSON.parse(fs.readFileSync(finalPath(homeDirectory), 'utf8')),
    ).toMatchObject({
      sessionId: SESSION_ID,
      title: TITLE,
    });
  });

  it('accepts full-argv clear and removes only the env-selected session', () => {
    const homeDirectory = home();
    expect(
      executeSessionTitleAnnotationCommand(['session', 'title', 'to clear'], {
        env: { LCARS_SESSION_ID: SESSION_ID },
        homeDirectory,
      }),
    ).toEqual({ ok: true });
    expect(
      executeSessionTitleAnnotationCommand(['session', 'title', '--clear'], {
        env: { LCARS_SESSION_ID: SESSION_ID },
        homeDirectory,
      }),
    ).toEqual({ ok: true });
    expect(fs.existsSync(finalPath(homeDirectory))).toBe(false);
  });

  it.each([
    ['bare title', ['a title']],
    ['bare clear', ['--clear']],
    ['missing prefix', ['title', 'a title']],
    ['wrong prefix', ['session', 'wrong', 'a title']],
    ['extra argument', ['session', 'title', 'a title', 'extra']],
    ['unknown flag', ['session', 'title', '--unknown']],
    ['empty title', ['session', 'title', '']],
  ] as const)('rejects %s without mutating state', (_label, argv) => {
    const homeDirectory = home();
    expect(
      executeSessionTitleAnnotationCommand(argv, {
        env: { LCARS_SESSION_ID: SESSION_ID },
        homeDirectory,
      }),
    ).toEqual({ ok: false, error: 'invalid-command' });
    expect(
      fs.existsSync(
        path.join(homeDirectory, SESSION_TITLE_ANNOTATION_DIRECTORY),
      ),
    ).toBe(false);
  });

  it('requires an env-provided safe ID and does not fall back to ambient process env', () => {
    const homeDirectory = home();
    process.env['LCARS_SESSION_ID'] = SESSION_ID;
    expect(
      executeSessionTitleAnnotationCommand(['session', 'title', TITLE], {
        env: {},
        homeDirectory,
      }),
    ).toEqual({ ok: false, error: 'invalid-session' });
    expect(
      fs.existsSync(
        path.join(homeDirectory, SESSION_TITLE_ANNOTATION_DIRECTORY),
      ),
    ).toBe(false);
  });

  it.each(['', '   ', '../escape', '-unsafe', 'unsafe/id'])(
    'rejects unsafe/missing ID %j',
    (id) => {
      const homeDirectory = home();
      expect(
        executeSessionTitleAnnotationCommand(['session', 'title', TITLE], {
          env: { LCARS_SESSION_ID: id },
          homeDirectory,
        }),
      ).toEqual({ ok: false, error: 'invalid-session' });
      expect(
        fs.existsSync(
          path.join(homeDirectory, SESSION_TITLE_ANNOTATION_DIRECTORY),
        ),
      ).toBe(false);
    },
  );

  it('returns only generic diagnostics and never leaks title text', () => {
    const homeDirectory = home();
    const result = executeSessionTitleAnnotationCommand(
      ['session', 'title', TITLE],
      {
        env: { LCARS_SESSION_ID: SESSION_ID },
        homeDirectory,
        platform: 'darwin',
      },
    );
    expect(JSON.stringify(result)).not.toContain(TITLE);
    expect(result).toEqual({ ok: false, error: 'write-failed' });
  });
});
