import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_NATIVE_TITLE_IMPORT_CAP,
  CODEX_NATIVE_TITLE_RECENCY_WINDOW_DAYS,
  pollCodexNativeTitles,
  resolveCodexStateDbPath,
} from './codex-native-title-source';

/** Pinned "now" for every recency-window computation below -- deterministic
 * tests, matching the writer's own `now?: () => Date` seam. */
const WHEN = new Date('2026-08-15T12:00:00.000Z');
const WHEN_SECONDS = Math.floor(WHEN.getTime() / 1000);

/** `updated_at` `secondsAgo` before `WHEN`, in the unix-seconds units the
 * real `threads.updated_at` column uses. Defaults to "1 minute ago" -- well
 * inside the 14-day window, but distinct enough from `WHEN_SECONDS` itself
 * to catch an accidental strict `>` where the query means `>=`. */
function recentUpdatedAt(secondsAgo = 60): number {
  return WHEN_SECONDS - secondsAgo;
}

interface ThreadFixtureRow {
  id: string;
  rollout_path: string | null;
  name: string | null;
  title: string | null;
  cwd?: string | null;
  updated_at?: number | null;
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-codex-db-'));
  dirs.push(value);
  return value;
}

/** Builds a real, on-disk SQLite `threads` table matching the frozen
 * schema from a real 560-row DB (cli_version 0.147.0) -- a fixture-backed
 * contract, not a hand-mocked row shape, so this test proves the module
 * actually speaks SQL to a real file rather than merely matching whatever
 * shape the source code happens to construct in memory. */
function fixtureDb(
  filePath: string,
  rows: readonly ThreadFixtureRow[],
  options: { omitTitleColumn?: boolean } = {},
): void {
  const db = new DatabaseSync(filePath);
  try {
    db.exec(
      options.omitTitleColumn
        ? `CREATE TABLE threads (
            id TEXT PRIMARY KEY,
            rollout_path TEXT,
            name TEXT NULL,
            cwd TEXT,
            updated_at INTEGER
          )`
        : `CREATE TABLE threads (
            id TEXT PRIMARY KEY,
            rollout_path TEXT,
            name TEXT NULL,
            title TEXT NOT NULL DEFAULT '',
            cwd TEXT,
            updated_at INTEGER
          )`,
    );
    const columns = options.omitTitleColumn
      ? ['id', 'rollout_path', 'name', 'cwd', 'updated_at']
      : ['id', 'rollout_path', 'name', 'title', 'cwd', 'updated_at'];
    const insert = db.prepare(
      `INSERT INTO threads (${columns.join(', ')}) VALUES (${columns
        .map(() => '?')
        .join(', ')})`,
    );
    for (const row of rows) {
      const values = columns.map((column) => {
        const value = (row as unknown as Record<string, unknown>)[column];
        return value === undefined ? null : value;
      });
      insert.run(...(values as never[]));
    }
  } finally {
    db.close();
  }
}

describe('pollCodexNativeTitles', () => {
  it('reads usable rows from a real fixture DB', () => {
    const dbPath = path.join(tempDir(), 'state_5.sqlite');
    fixtureDb(dbPath, [
      {
        id: 'codex-session-1',
        rollout_path:
          '/home/user/.codex/sessions/2026/08/15/rollout-codex-session-1.jsonl',
        name: null,
        title: 'Fix the flaky test',
        cwd: '/home/user/p/agent-lcars',
        updated_at: recentUpdatedAt(),
      },
    ]);

    expect(pollCodexNativeTitles(dbPath, { now: () => WHEN })).toEqual([
      { sessionId: 'codex-session-1', title: 'Fix the flaky test' },
    ]);
  });

  it('prefers a deliberate name over the generated title', () => {
    const dbPath = path.join(tempDir(), 'state_5.sqlite');
    fixtureDb(dbPath, [
      {
        id: 'codex-session-2',
        rollout_path:
          '/home/user/.codex/sessions/rollout-codex-session-2.jsonl',
        name: 'My deliberate rename',
        title: 'Auto-generated title nobody chose',
        cwd: '/home/user/p/agent-lcars',
        updated_at: recentUpdatedAt(),
      },
    ]);

    expect(pollCodexNativeTitles(dbPath, { now: () => WHEN })).toEqual([
      { sessionId: 'codex-session-2', title: 'My deliberate rename' },
    ]);
  });

  it('falls back to title when name is null or blank', () => {
    const dbPath = path.join(tempDir(), 'state_5.sqlite');
    fixtureDb(dbPath, [
      {
        id: 'codex-session-null-name',
        rollout_path: '/rollouts/a.jsonl',
        name: null,
        title: 'Generated only',
        // Newer than the row below -- `ORDER BY updated_at DESC` must keep
        // this one first, matching the order asserted below.
        updated_at: recentUpdatedAt(60),
      },
      {
        id: 'codex-session-blank-name',
        rollout_path: '/rollouts/b.jsonl',
        name: '   ',
        title: 'Generated fallback for blank name',
        updated_at: recentUpdatedAt(120),
      },
    ]);

    expect(pollCodexNativeTitles(dbPath, { now: () => WHEN })).toEqual([
      { sessionId: 'codex-session-null-name', title: 'Generated only' },
      {
        sessionId: 'codex-session-blank-name',
        title: 'Generated fallback for blank name',
      },
    ]);
  });

  it('skips a row with an unsafe id', () => {
    const dbPath = path.join(tempDir(), 'state_5.sqlite');
    fixtureDb(dbPath, [
      {
        id: '../escape',
        rollout_path: '/rollouts/a.jsonl',
        name: null,
        title: 'x',
        updated_at: recentUpdatedAt(),
      },
      {
        id: 'unsafe/id',
        rollout_path: '/rollouts/b.jsonl',
        name: null,
        title: 'x',
        updated_at: recentUpdatedAt(),
      },
      {
        id: 'safe-id-1',
        rollout_path: '/rollouts/c.jsonl',
        name: null,
        title: 'kept',
        updated_at: recentUpdatedAt(),
      },
    ]);

    expect(pollCodexNativeTitles(dbPath, { now: () => WHEN })).toEqual([
      { sessionId: 'safe-id-1', title: 'kept' },
    ]);
  });

  it('skips a row with an empty title after truncateTitle normalizes it', () => {
    const dbPath = path.join(tempDir(), 'state_5.sqlite');
    fixtureDb(dbPath, [
      {
        id: 'blank-both',
        rollout_path: '/rollouts/a.jsonl',
        name: '   ',
        title: '   ',
        updated_at: recentUpdatedAt(),
      },
      {
        id: 'empty-both',
        rollout_path: '/rollouts/b.jsonl',
        name: '',
        title: '',
        updated_at: recentUpdatedAt(),
      },
      {
        id: 'kept',
        rollout_path: '/rollouts/c.jsonl',
        name: null,
        title: 'kept',
        updated_at: recentUpdatedAt(),
      },
    ]);

    expect(pollCodexNativeTitles(dbPath, { now: () => WHEN })).toEqual([
      { sessionId: 'kept', title: 'kept' },
    ]);
  });

  it('skips a row with a missing or blank rollout_path', () => {
    const dbPath = path.join(tempDir(), 'state_5.sqlite');
    fixtureDb(dbPath, [
      {
        id: 'no-rollout',
        rollout_path: null,
        name: null,
        title: 'x',
        updated_at: recentUpdatedAt(),
      },
      {
        id: 'blank-rollout',
        rollout_path: '   ',
        name: null,
        title: 'x',
        updated_at: recentUpdatedAt(),
      },
      {
        id: 'kept',
        rollout_path: '/rollouts/c.jsonl',
        name: null,
        title: 'kept',
        updated_at: recentUpdatedAt(),
      },
    ]);

    expect(pollCodexNativeTitles(dbPath, { now: () => WHEN })).toEqual([
      { sessionId: 'kept', title: 'kept' },
    ]);
  });

  it('applies the shared truncateTitle policy to an overlong title', () => {
    const dbPath = path.join(tempDir(), 'state_5.sqlite');
    fixtureDb(dbPath, [
      {
        id: 'long-title',
        rollout_path: '/rollouts/a.jsonl',
        name: null,
        title: 'x'.repeat(100),
        updated_at: recentUpdatedAt(),
      },
    ]);

    expect(pollCodexNativeTitles(dbPath, { now: () => WHEN })).toEqual([
      { sessionId: 'long-title', title: `${'x'.repeat(79)}…` },
    ]);
  });

  it('excludes a row outside the recency window, keeps one just inside it', () => {
    const dbPath = path.join(tempDir(), 'state_5.sqlite');
    const windowSeconds = CODEX_NATIVE_TITLE_RECENCY_WINDOW_DAYS * 24 * 60 * 60;
    fixtureDb(dbPath, [
      {
        id: 'just-outside',
        rollout_path: '/rollouts/a.jsonl',
        name: null,
        title: 'too old',
        // One second older than the cutoff -- excluded.
        updated_at: WHEN_SECONDS - windowSeconds - 1,
      },
      {
        id: 'just-inside',
        rollout_path: '/rollouts/b.jsonl',
        name: null,
        title: 'kept',
        // Exactly at the cutoff -- the query is `>=`, so this is included.
        updated_at: WHEN_SECONDS - windowSeconds,
      },
    ]);

    expect(pollCodexNativeTitles(dbPath, { now: () => WHEN })).toEqual([
      { sessionId: 'just-inside', title: 'kept' },
    ]);
  });

  it('caps a single import at CODEX_NATIVE_TITLE_IMPORT_CAP, keeping the newest rows', () => {
    const dbPath = path.join(tempDir(), 'state_5.sqlite');
    const total = CODEX_NATIVE_TITLE_IMPORT_CAP + 10;
    const rows: ThreadFixtureRow[] = [];
    for (let index = 0; index < total; index += 1) {
      rows.push({
        id: `session-${String(index).padStart(4, '0')}`,
        rollout_path: `/rollouts/${index}.jsonl`,
        name: null,
        title: `title ${index}`,
        // Higher index == more recently updated, all well inside the
        // window -- the cap, not the window, is what's under test here.
        updated_at: recentUpdatedAt(total - index),
      });
    }
    fixtureDb(dbPath, rows);

    const result = pollCodexNativeTitles(dbPath, { now: () => WHEN });

    expect(result).toHaveLength(CODEX_NATIVE_TITLE_IMPORT_CAP);
    // Newest first: the last `CAP` rows inserted (highest indices), in
    // descending order.
    const expectedIds = Array.from(
      { length: CODEX_NATIVE_TITLE_IMPORT_CAP },
      (_, position) => {
        const index = total - 1 - position;
        return `session-${String(index).padStart(4, '0')}`;
      },
    );
    expect(result.map((candidate) => candidate.sessionId)).toEqual(expectedIds);
  });

  it('fails soft and reports unavailability on a missing file', () => {
    const missing = path.join(tempDir(), 'does-not-exist.sqlite');
    const errors: unknown[] = [];
    expect(
      pollCodexNativeTitles(missing, { onUnavailable: (e) => errors.push(e) }),
    ).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('fails soft and reports unavailability when an expected column is missing', () => {
    const dbPath = path.join(tempDir(), 'state_5.sqlite');
    fixtureDb(
      dbPath,
      [{ id: 'x', rollout_path: '/rollouts/a.jsonl', name: null, title: null }],
      { omitTitleColumn: true },
    );
    const errors: unknown[] = [];
    expect(
      pollCodexNativeTitles(dbPath, { onUnavailable: (e) => errors.push(e) }),
    ).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('fails soft and reports unavailability on a locked database', () => {
    const dbPath = path.join(tempDir(), 'state_5.sqlite');
    fixtureDb(dbPath, [
      {
        id: 'x',
        rollout_path: '/rollouts/a.jsonl',
        name: null,
        title: 'kept',
        updated_at: recentUpdatedAt(),
      },
    ]);
    const writer = new DatabaseSync(dbPath);
    writer.exec('BEGIN EXCLUSIVE');
    writer.exec(
      "INSERT INTO threads (id, rollout_path, name, title) VALUES ('y', '/rollouts/b.jsonl', NULL, 'locked-insert')",
    );
    try {
      const errors: unknown[] = [];
      expect(
        pollCodexNativeTitles(dbPath, { onUnavailable: (e) => errors.push(e) }),
      ).toEqual([]);
      expect(errors).toHaveLength(1);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
  });

  it('fails soft and reports unavailability when the injected clock is invalid', () => {
    const dbPath = path.join(tempDir(), 'state_5.sqlite');
    fixtureDb(dbPath, [
      {
        id: 'x',
        rollout_path: '/rollouts/a.jsonl',
        name: null,
        title: 'kept',
        updated_at: recentUpdatedAt(),
      },
    ]);
    const errors: unknown[] = [];
    expect(
      pollCodexNativeTitles(dbPath, {
        now: () => new Date(Number.NaN),
        onUnavailable: (e) => errors.push(e),
      }),
    ).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe('resolveCodexStateDbPath', () => {
  it('uses the env override verbatim when set to a non-empty value', () => {
    expect(
      resolveCodexStateDbPath({
        env: { AGENT_TELEMETRY_CODEX_STATE_DB: '/custom/state.sqlite' },
      }),
    ).toBe('/custom/state.sqlite');
  });

  it('treats an explicit empty-string override as opt-out', () => {
    expect(
      resolveCodexStateDbPath({ env: { AGENT_TELEMETRY_CODEX_STATE_DB: '' } }),
    ).toBeUndefined();
  });

  it('discovers the newest state_*.sqlite by numeric suffix, not by name sort', () => {
    const home = tempDir();
    const codexDir = path.join(home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'state_9.sqlite'), '');
    fs.writeFileSync(path.join(codexDir, 'state_10.sqlite'), '');
    fs.writeFileSync(path.join(codexDir, 'state_2.sqlite'), '');

    expect(resolveCodexStateDbPath({ env: {}, homeDirectory: home })).toBe(
      path.join(codexDir, 'state_10.sqlite'),
    );
  });

  it('ignores files that do not match the state_<n>.sqlite pattern', () => {
    const home = tempDir();
    const codexDir = path.join(home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'auth.json'), '');
    fs.writeFileSync(path.join(codexDir, 'history.jsonl'), '');
    fs.writeFileSync(path.join(codexDir, 'state_3.sqlite'), '');
    fs.writeFileSync(path.join(codexDir, 'state_3.sqlite-wal'), '');

    expect(resolveCodexStateDbPath({ env: {}, homeDirectory: home })).toBe(
      path.join(codexDir, 'state_3.sqlite'),
    );
  });

  it('returns undefined when no state_*.sqlite file exists', () => {
    const home = tempDir();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    expect(
      resolveCodexStateDbPath({ env: {}, homeDirectory: home }),
    ).toBeUndefined();
  });

  it('returns undefined when ~/.codex does not exist at all', () => {
    const home = tempDir();
    expect(
      resolveCodexStateDbPath({ env: {}, homeDirectory: home }),
    ).toBeUndefined();
  });
});
