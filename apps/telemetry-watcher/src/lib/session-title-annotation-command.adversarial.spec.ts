import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CLI_SESSION_RETENTION_DAYS } from '@agent-lcars/telemetry';
import { afterEach, describe, expect, it } from 'vitest';

import {
  executeSessionTitleAnnotationCommand,
  SESSION_TITLE_CLI_USAGE,
} from './session-title-annotation-command';
import { SessionTitleAnnotationWriterFileSystem } from './session-title-annotation-writer';

const SESSION_ID = 'command-session-1';
const TITLE = 'title must never be echoed in an error';
const STATUS = 'status must never be echoed in an error';
/** Pinned clock every `import-native` test below passes as `now` (issue
 * #1224's recency-windowed query needs a deterministic "now" to compare
 * `updated_at` fixture values against). Also backs `fixtureCodexDb`'s
 * default `updated_at`, so a caller that doesn't care about recency at all
 * still lands comfortably inside the window. */
const IMPORT_WHEN = new Date('2026-08-15T00:00:00.000Z');
const DEFAULT_FIXTURE_UPDATED_AT =
  Math.floor(IMPORT_WHEN.getTime() / 1000) - 3600;
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0))
    fs.rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-title-command-'));
  homes.push(value);
  return value;
}

function declaredPath(homeDirectory: string, sessionId = SESSION_ID): string {
  return path.join(
    homeDirectory,
    '.local',
    'state',
    'agent-lcars',
    'session-metadata',
    `${sessionId}.json`,
  );
}

function generatedPath(homeDirectory: string, sessionId: string): string {
  return path.join(
    homeDirectory,
    '.local',
    'state',
    'agent-lcars',
    'native-titles',
    `${sessionId}.json`,
  );
}

function statusPath(homeDirectory: string, sessionId = SESSION_ID): string {
  return path.join(
    homeDirectory,
    '.local',
    'state',
    'agent-lcars',
    'session-status',
    `${sessionId}.json`,
  );
}

function fixtureCodexDb(
  homeDirectory: string,
  rows: readonly {
    id: string;
    rollout_path: string;
    name: string | null;
    title: string | null;
    /** Defaults to `DEFAULT_FIXTURE_UPDATED_AT` -- comfortably inside the
     * importer's recency window relative to `IMPORT_WHEN` -- for callers
     * that don't care about recency and just want a plain usable row. */
    updated_at?: number;
  }[],
): void {
  const codexDir = path.join(homeDirectory, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  const db = new DatabaseSync(path.join(codexDir, 'state_5.sqlite'));
  try {
    db.exec(
      `CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT,
        name TEXT NULL,
        title TEXT NOT NULL DEFAULT '',
        cwd TEXT,
        updated_at INTEGER
      )`,
    );
    const insert = db.prepare(
      'INSERT INTO threads (id, rollout_path, name, title, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    // A single explicit transaction, not one implicit commit per `run()` --
    // every call site here only ever passes a handful of rows, so this
    // never showed up as a timeout in this particular file, but the same
    // per-row-fsync exposure exists in principle (issue #1224 CI
    // follow-up: `codex-native-title-source.spec.ts` and
    // `session-title-overlay.integration.spec.ts` both did time out on a
    // slow-disk CI runner from exactly this pattern at higher row counts).
    // Kept consistent here rather than left as a latent trap for the next
    // caller that grows this fixture into a bulk one.
    db.exec('BEGIN');
    for (const row of rows) {
      insert.run(
        row.id,
        row.rollout_path,
        row.name,
        row.title ?? '',
        row.updated_at ?? DEFAULT_FIXTURE_UPDATED_AT,
      );
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

describe('session title command grammar and dispatch', () => {
  it('accepts a title command and reads the id via session-id resolution', () => {
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
      JSON.parse(fs.readFileSync(declaredPath(homeDirectory), 'utf8')),
    ).toMatchObject({ sessionId: SESSION_ID, title: TITLE });
  });

  it('resolves the id from CLAUDE_CODE_SESSION_ID when LCARS_SESSION_ID is absent', () => {
    const homeDirectory = home();
    expect(
      executeSessionTitleAnnotationCommand(['session', 'title', TITLE], {
        env: { CLAUDE_CODE_SESSION_ID: SESSION_ID },
        homeDirectory,
      }),
    ).toEqual({ ok: true });
    expect(fs.existsSync(declaredPath(homeDirectory))).toBe(true);
  });

  it('resolves the id from CODEX_THREAD_ID when the other two are absent', () => {
    const homeDirectory = home();
    expect(
      executeSessionTitleAnnotationCommand(['session', 'title', TITLE], {
        env: { CODEX_THREAD_ID: SESSION_ID },
        homeDirectory,
      }),
    ).toEqual({ ok: true });
    expect(fs.existsSync(declaredPath(homeDirectory))).toBe(true);
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
    expect(fs.existsSync(declaredPath(homeDirectory))).toBe(false);
  });

  it.each([
    ['bare title', ['a title']],
    ['bare clear', ['--clear']],
    ['missing prefix', ['title', 'a title']],
    ['wrong prefix', ['session', 'wrong', 'a title']],
    ['extra argument', ['session', 'title', 'a title', 'extra']],
    ['unknown flag', ['session', 'title', '--unknown']],
    ['empty title', ['session', 'title', '']],
    [
      'import-native with an extra argument',
      ['session', 'import-native', 'extra'],
    ],
  ] as const)(
    'rejects %s without mutating state, with usage attached',
    (_label, argv) => {
      const homeDirectory = home();
      expect(
        executeSessionTitleAnnotationCommand(argv, {
          env: { LCARS_SESSION_ID: SESSION_ID },
          homeDirectory,
        }),
      ).toEqual({
        ok: false,
        error: 'invalid-command',
        usage: SESSION_TITLE_CLI_USAGE,
      });
      expect(fs.existsSync(path.join(homeDirectory, '.local'))).toBe(false);
    },
  );

  it.each([
    ['no argv', []],
    ['--help', ['--help']],
    ['-h', ['-h']],
    ['help', ['help']],
  ] as const)(
    '%s reports the terse usage surface without requiring a session id',
    (_label, argv) => {
      const homeDirectory = home();
      expect(
        executeSessionTitleAnnotationCommand(argv, { env: {}, homeDirectory }),
      ).toEqual({ ok: true, usage: SESSION_TITLE_CLI_USAGE });
      expect(fs.existsSync(path.join(homeDirectory, '.local'))).toBe(false);
    },
  );

  it('requires an env-provided safe ID and does not fall back to ambient process env', () => {
    const homeDirectory = home();
    process.env['LCARS_SESSION_ID'] = SESSION_ID;
    try {
      expect(
        executeSessionTitleAnnotationCommand(['session', 'title', TITLE], {
          env: {},
          homeDirectory,
        }),
      ).toEqual({ ok: false, error: 'invalid-session' });
      expect(fs.existsSync(path.join(homeDirectory, '.local'))).toBe(false);
    } finally {
      delete process.env['LCARS_SESSION_ID'];
    }
  });

  it.each(['', '   ', '../escape', '-unsafe', 'unsafe/id'])(
    'rejects unsafe/missing ID %j without falling through to a lower-priority variable',
    (id) => {
      const homeDirectory = home();
      expect(
        executeSessionTitleAnnotationCommand(['session', 'title', TITLE], {
          env: {
            LCARS_SESSION_ID: id,
            CLAUDE_CODE_SESSION_ID: 'safe-fallback',
          },
          homeDirectory,
        }),
      ).toEqual({ ok: false, error: 'invalid-session' });
      expect(fs.existsSync(declaredPath(homeDirectory, 'safe-fallback'))).toBe(
        false,
      );
    },
  );

  it('returns only generic diagnostics and never leaks title text on a write failure', () => {
    const homeDirectory = home();
    const writeFileSync: SessionTitleAnnotationWriterFileSystem['writeFileSync'] =
      () => {
        throw new Error('disk full');
      };
    const result = executeSessionTitleAnnotationCommand(
      ['session', 'title', TITLE],
      {
        env: { LCARS_SESSION_ID: SESSION_ID },
        homeDirectory,
        fileSystem: { writeFileSync },
      },
    );
    expect(JSON.stringify(result)).not.toContain(TITLE);
    expect(result).toEqual({ ok: false, error: 'write-failed' });
  });
});

describe('session status command grammar and dispatch', () => {
  it('accepts a status command and reads the id via session-id resolution', () => {
    const homeDirectory = home();
    const result = executeSessionTitleAnnotationCommand(
      ['session', 'status', STATUS],
      {
        env: { LCARS_SESSION_ID: SESSION_ID },
        homeDirectory,
        now: () => new Date('2026-08-15T12:34:56.000Z'),
      },
    );

    expect(result).toEqual({ ok: true });
    expect(
      JSON.parse(fs.readFileSync(statusPath(homeDirectory), 'utf8')),
    ).toMatchObject({ sessionId: SESSION_ID, status: STATUS });
  });

  it('accepts full-argv clear and removes only the env-selected session', () => {
    const homeDirectory = home();
    expect(
      executeSessionTitleAnnotationCommand(['session', 'status', 'to clear'], {
        env: { LCARS_SESSION_ID: SESSION_ID },
        homeDirectory,
      }),
    ).toEqual({ ok: true });
    expect(
      executeSessionTitleAnnotationCommand(['session', 'status', '--clear'], {
        env: { LCARS_SESSION_ID: SESSION_ID },
        homeDirectory,
      }),
    ).toEqual({ ok: true });
    expect(fs.existsSync(statusPath(homeDirectory))).toBe(false);
  });

  it('never disturbs a declared title for the same session', () => {
    const homeDirectory = home();
    executeSessionTitleAnnotationCommand(['session', 'title', TITLE], {
      env: { LCARS_SESSION_ID: SESSION_ID },
      homeDirectory,
    });

    executeSessionTitleAnnotationCommand(['session', 'status', STATUS], {
      env: { LCARS_SESSION_ID: SESSION_ID },
      homeDirectory,
    });
    executeSessionTitleAnnotationCommand(['session', 'status', '--clear'], {
      env: { LCARS_SESSION_ID: SESSION_ID },
      homeDirectory,
    });

    expect(
      JSON.parse(fs.readFileSync(declaredPath(homeDirectory), 'utf8')),
    ).toMatchObject({ title: TITLE });
  });

  it.each([
    ['bare status', ['a status']],
    ['bare clear', ['--clear']],
    ['missing prefix', ['status', 'a status']],
    ['extra argument', ['session', 'status', 'a status', 'extra']],
    ['unknown flag', ['session', 'status', '--unknown']],
    ['empty status', ['session', 'status', '']],
  ] as const)(
    'rejects %s without mutating state, with usage attached',
    (_label, argv) => {
      const homeDirectory = home();
      expect(
        executeSessionTitleAnnotationCommand(argv, {
          env: { LCARS_SESSION_ID: SESSION_ID },
          homeDirectory,
        }),
      ).toEqual({
        ok: false,
        error: 'invalid-command',
        usage: SESSION_TITLE_CLI_USAGE,
      });
      expect(fs.existsSync(path.join(homeDirectory, '.local'))).toBe(false);
    },
  );

  it('requires an env-provided safe ID, same resolution as session title', () => {
    const homeDirectory = home();
    expect(
      executeSessionTitleAnnotationCommand(['session', 'status', STATUS], {
        env: {},
        homeDirectory,
      }),
    ).toEqual({ ok: false, error: 'invalid-session' });
    expect(fs.existsSync(path.join(homeDirectory, '.local'))).toBe(false);
  });

  it('returns only generic diagnostics and never leaks status text on a write failure', () => {
    const homeDirectory = home();
    const writeFileSync: SessionTitleAnnotationWriterFileSystem['writeFileSync'] =
      () => {
        throw new Error('disk full');
      };
    const result = executeSessionTitleAnnotationCommand(
      ['session', 'status', STATUS],
      {
        env: { LCARS_SESSION_ID: SESSION_ID },
        homeDirectory,
        fileSystem: { writeFileSync },
      },
    );
    expect(JSON.stringify(result)).not.toContain(STATUS);
    expect(result).toEqual({ ok: false, error: 'write-failed' });
  });
});

describe('session import-native dispatch', () => {
  it('does not require a current session id', () => {
    const homeDirectory = home();
    expect(
      executeSessionTitleAnnotationCommand(['session', 'import-native'], {
        env: {},
        homeDirectory,
      }),
    ).toEqual({ ok: true });
  });

  it('fails soft to ok:true and imports nothing when no Codex state DB exists', () => {
    const homeDirectory = home();
    expect(
      executeSessionTitleAnnotationCommand(['session', 'import-native'], {
        env: {},
        homeDirectory,
      }),
    ).toEqual({ ok: true });
    expect(fs.existsSync(path.join(homeDirectory, '.local', 'state'))).toBe(
      false,
    );
  });

  it('imports usable rows from a real fixture Codex DB into the generated channel', () => {
    const homeDirectory = home();
    fixtureCodexDb(homeDirectory, [
      {
        id: 'codex-session-a',
        rollout_path: '/rollouts/a.jsonl',
        name: 'A deliberate rename',
        title: 'auto title',
      },
      {
        id: 'codex-session-b',
        rollout_path: '/rollouts/b.jsonl',
        name: null,
        title: 'generated only',
      },
      // Skipped: unsafe id.
      {
        id: '../escape',
        rollout_path: '/rollouts/c.jsonl',
        name: null,
        title: 'x',
      },
    ]);

    expect(
      executeSessionTitleAnnotationCommand(['session', 'import-native'], {
        env: {},
        homeDirectory,
        now: () => IMPORT_WHEN,
      }),
    ).toEqual({ ok: true });

    expect(
      JSON.parse(
        fs.readFileSync(
          generatedPath(homeDirectory, 'codex-session-a'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      sessionId: 'codex-session-a',
      title: 'A deliberate rename',
    });
    expect(
      JSON.parse(
        fs.readFileSync(
          generatedPath(homeDirectory, 'codex-session-b'),
          'utf8',
        ),
      ),
    ).toMatchObject({ sessionId: 'codex-session-b', title: 'generated only' });
    expect(fs.existsSync(generatedPath(homeDirectory, '../escape'))).toBe(
      false,
    );
  });

  it('is idempotent: rerunning with unchanged input and a pinned clock rewrites byte-identical files', () => {
    const homeDirectory = home();
    fixtureCodexDb(homeDirectory, [
      {
        id: 'codex-session-a',
        rollout_path: '/rollouts/a.jsonl',
        name: 'stable name',
        title: 'stable title',
      },
    ]);
    const dependencies = {
      env: {},
      homeDirectory,
      now: () => IMPORT_WHEN,
    };

    executeSessionTitleAnnotationCommand(
      ['session', 'import-native'],
      dependencies,
    );
    const first = fs.readFileSync(
      generatedPath(homeDirectory, 'codex-session-a'),
      'utf8',
    );
    executeSessionTitleAnnotationCommand(
      ['session', 'import-native'],
      dependencies,
    );
    const second = fs.readFileSync(
      generatedPath(homeDirectory, 'codex-session-a'),
      'utf8',
    );

    expect(second).toBe(first);
  });

  it('also prunes a stale status annotation, unconditionally like the declared channel', () => {
    const homeDirectory = home();
    executeSessionTitleAnnotationCommand(
      ['session', 'status', 'stale status'],
      {
        env: { LCARS_SESSION_ID: 'stale-status-session' },
        homeDirectory,
        now: () => IMPORT_WHEN,
      },
    );
    const staleTime = new Date(
      IMPORT_WHEN.getTime() -
        (CLI_SESSION_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
    );
    fs.utimesSync(
      statusPath(homeDirectory, 'stale-status-session'),
      staleTime,
      staleTime,
    );

    const result = executeSessionTitleAnnotationCommand(
      ['session', 'import-native'],
      { env: {}, homeDirectory, now: () => IMPORT_WHEN },
    );

    expect(result).toEqual({ ok: true });
    expect(
      fs.existsSync(statusPath(homeDirectory, 'stale-status-session')),
    ).toBe(false);
  });
});
