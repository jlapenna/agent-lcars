import { DatabaseSync } from 'node:sqlite';

import {
  applySessionTitleOverlay,
  SessionSummary,
} from '@agent-lcars/telemetry';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CODEX_NATIVE_TITLE_IMPORT_CAP,
  CODEX_NATIVE_TITLE_RECENCY_WINDOW_DAYS,
} from './codex-native-title-source';
import { executeSessionTitleAnnotationCommand } from './session-title-annotation-command';
import {
  MAX_SESSION_TITLE_ANNOTATION_FILES,
  readSessionTitleOverlay,
} from './session-title-annotation-source';
import { SESSION_STATE_DIRECTORY } from './session-title-paths';

/** Builds (or adds to, if `dbPath` already exists -- see the rotation test
 * below, which calls this twice against the same file to model new threads
 * accumulating in an already-populated store) a real, on-disk SQLite
 * `threads` table -- same frozen shape as `codex-native-title-source.spec
 * .ts`'s own fixture builder -- with as many rows as the caller wants, each
 * with an explicit `updated_at`. `INSERT OR REPLACE` so a second call can
 * freely reuse an id from a first call without a primary-key conflict, the
 * same "last write wins" semantics `threads` itself has. Used below to
 * reproduce issue #1224 for real: an importer fixture with more usable rows
 * than the reader's cap, run through the real command and read back through
 * the real reader, no mocks anywhere in between. */
function fixtureCodexDb(
  dbPath: string,
  rows: readonly {
    id: string;
    rollout_path: string;
    title: string;
    updated_at: number;
  }[],
): void {
  const database = new DatabaseSync(dbPath);
  try {
    database.exec(
      `CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY,
       rollout_path TEXT NOT NULL, name TEXT, title TEXT NOT NULL DEFAULT '',
       cwd TEXT, updated_at INTEGER)`,
    );
    const insert = database.prepare(
      'INSERT OR REPLACE INTO threads (id, rollout_path, name, title, cwd, updated_at) VALUES (?, ?, NULL, ?, ?, ?)',
    );
    for (const row of rows) {
      insert.run(
        row.id,
        row.rollout_path,
        row.title,
        '/home/u/p',
        row.updated_at,
      );
    }
  } finally {
    database.close();
  }
}

function paddedId(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(4, '0')}`;
}

/**
 * The composition, not the pieces. Every module below has its own unit tests
 * and all of them passed while this feature did nothing whatsoever for four
 * landed PRs (#1154, #1156, #1159) — the defect was never inside a unit, it
 * was that nothing joined them and the precedence discarded the result. So
 * this suite deliberately injects no filesystem seams and no fake candidates:
 * it drives the real command, writes to a real temp HOME, reads back through
 * the real directory reader, and applies the real overlay.
 */
describe('session title overlay, end to end', () => {
  const sessionId = '69618f46-c334-4823-ba90-d484f6b64b06';
  /** Pinned clock for every `import-native` call below (issue #1224's
   * recency-windowed query needs a deterministic "now" to compare
   * `updated_at` fixture values against). */
  const IMPORT_WHEN = new Date('2026-08-16T00:00:00.000Z');
  let homeDirectory: string;
  let stateDirectory: string;

  /** A summary shaped like what the Claude reducer actually emits: an
   * `aiTitle` reduced to the `generated` tier. This is the ~95% case (38 of
   * 40 recent transcripts carry one), and it is the case the landed
   * precedence got wrong. */
  const claudeSummary = (): SessionSummary => ({
    sessionId,
    source: 'cli',
    agent: 'claude-code',
    startedAt: '2026-08-16T00:00:00.000Z',
    lastActivityAt: '2026-08-16T01:00:00.000Z',
    turns: 40,
    toolCallCounts: {},
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    title: 'Run unit tests and fix failures',
    titleSource: 'generated',
    deliverables: { prNumbers: [], commitShas: [] },
  });

  beforeEach(() => {
    homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-overlay-'));
    stateDirectory = path.join(homeDirectory, SESSION_STATE_DIRECTORY);
  });

  afterEach(() => {
    fs.rmSync(homeDirectory, { recursive: true, force: true });
  });

  it('lets an agent rename a session that already has a stale aiTitle', () => {
    // No LCARS_SESSION_ID: the whole point is that a real Claude Code session
    // supplies nothing but CLAUDE_CODE_SESSION_ID, which nothing in the repo
    // read before this change.
    const written = executeSessionTitleAnnotationCommand(
      ['session', 'title', 'Land session titles end to end'],
      { homeDirectory, env: { CLAUDE_CODE_SESSION_ID: sessionId } },
    );
    expect(written.ok).toBe(true);

    const overlay = readSessionTitleOverlay(stateDirectory);
    expect(overlay.declared.available).toBe(true);

    const result = applySessionTitleOverlay(claudeSummary(), {
      declared: overlay.declared.annotations.get(sessionId),
      generated: overlay.generated.annotations.get(sessionId),
    });

    // Under the superseded `explicit > annotation > inferred` order this
    // assertion fails: the stale aiTitle wins and the agent's statement is
    // silently discarded. That is the bug this issue exists to fix.
    expect(result.title).toBe('Land session titles end to end');
    expect(result.titleSource).toBe('declared');
  });

  it('reverts to the transcript title when the annotation is removed', () => {
    executeSessionTitleAnnotationCommand(
      ['session', 'title', 'Land session titles end to end'],
      { homeDirectory, env: { CLAUDE_CODE_SESSION_ID: sessionId } },
    );
    const cleared = executeSessionTitleAnnotationCommand(
      ['session', 'title', '--clear'],
      { homeDirectory, env: { CLAUDE_CODE_SESSION_ID: sessionId } },
    );
    expect(cleared.ok).toBe(true);

    const overlay = readSessionTitleOverlay(stateDirectory);
    // Available with nothing in it — a real state, distinct from unreadable.
    expect(overlay.declared.available).toBe(true);
    expect(overlay.declared.annotations.size).toBe(0);

    const result = applySessionTitleOverlay(claudeSummary(), {
      declared: overlay.declared.annotations.get(sessionId),
      generated: overlay.generated.annotations.get(sessionId),
    });

    // #1161 held activation pending a Firestore field-deletion operation for
    // exactly this moment. No deletion is needed: the summary handed to the
    // overlay is always the pristine reducer output, so removal falls back to
    // the transcript's own title and the doc still carries one.
    expect(result.title).toBe('Run unit tests and fix failures');
    expect(result.titleSource).toBe('generated');
  });

  it('imports a Codex native title over an inferred prompt fragment', () => {
    const codexSessionId = '01a007d8-6299-7471-b518-1118ab8e94af';
    const stateDbPath = path.join(homeDirectory, 'state_5.sqlite');
    const database = new DatabaseSync(stateDbPath);
    // Only the columns this importer reads, with the shape frozen from a real
    // 560-row store (cli_version 0.147.0).
    database.exec(
      `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL,
       name TEXT, title TEXT NOT NULL DEFAULT '', cwd TEXT, updated_at INTEGER)`,
    );
    // `updated_at` an hour before the pinned import clock below -- well
    // inside the importer's recency window, not the epoch-adjacent `1` a
    // pre-#1224 import never checked at all.
    const recentUpdatedAt = Math.floor(IMPORT_WHEN.getTime() / 1000) - 3600;
    database.exec(
      `INSERT INTO threads VALUES ('${codexSessionId}',
       '/home/u/.codex/sessions/2026/08/15/rollout-${codexSessionId}.jsonl',
       NULL, 'Investigate accidentally closed GitHub issues', '/home/u/p', ${recentUpdatedAt})`,
    );
    database.close();

    const imported = executeSessionTitleAnnotationCommand(
      ['session', 'import-native'],
      {
        homeDirectory,
        env: { AGENT_TELEMETRY_CODEX_STATE_DB: stateDbPath },
        now: () => IMPORT_WHEN,
      },
    );
    expect(imported.ok).toBe(true);

    const overlay = readSessionTitleOverlay(stateDirectory);
    expect(overlay.generated.available).toBe(true);

    // A Codex transcript yields only an inferred first-user-message fragment;
    // the native title is the whole reason this import exists.
    const codexSummary: SessionSummary = {
      ...claudeSummary(),
      sessionId: codexSessionId,
      agent: 'codex',
      title: 'accidentally closed issues. I think GitHub randomly closed',
      titleSource: 'inferred',
    };

    const result = applySessionTitleOverlay(codexSummary, {
      declared: overlay.declared.annotations.get(codexSessionId),
      generated: overlay.generated.annotations.get(codexSessionId),
    });

    expect(result.title).toBe('Investigate accidentally closed GitHub issues');
    expect(result.titleSource).toBe('generated');
  });

  it('keeps a declared title above an imported native one', () => {
    const stateDbPath = path.join(homeDirectory, 'state_5.sqlite');
    const database = new DatabaseSync(stateDbPath);
    database.exec(
      `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL,
       name TEXT, title TEXT NOT NULL DEFAULT '', cwd TEXT, updated_at INTEGER)`,
    );
    const recentUpdatedAt = Math.floor(IMPORT_WHEN.getTime() / 1000) - 3600;
    database.exec(
      `INSERT INTO threads VALUES ('${sessionId}', '/r/${sessionId}.jsonl',
       NULL, 'Codex auto-generated label', '/home/u/p', ${recentUpdatedAt})`,
    );
    database.close();

    executeSessionTitleAnnotationCommand(['session', 'import-native'], {
      homeDirectory,
      env: { AGENT_TELEMETRY_CODEX_STATE_DB: stateDbPath },
      now: () => IMPORT_WHEN,
    });
    executeSessionTitleAnnotationCommand(
      ['session', 'title', 'What the agent says it is doing now'],
      { homeDirectory, env: { CODEX_THREAD_ID: sessionId } },
    );

    const overlay = readSessionTitleOverlay(stateDirectory);
    const result = applySessionTitleOverlay(
      { ...claudeSummary(), title: undefined, titleSource: undefined },
      {
        declared: overlay.declared.annotations.get(sessionId),
        generated: overlay.generated.annotations.get(sessionId),
      },
    );

    // The two channels are separate files precisely so neither clobbers the
    // other; intent then outranks the machine label.
    expect(result.title).toBe('What the agent says it is doing now');
    expect(result.titleSource).toBe('declared');
  });

  /**
   * The issue #1224 regression suite. Every test above (and every test in
   * `codex-native-title-source.spec.ts` and the two adversarial specs)
   * passed while this bug shipped: the importer's own fixtures never held
   * more than a handful of rows, and the reader's own overflow test built a
   * synthetic over-cap directory no importer ever produced. So these tests
   * deliberately do what neither side's own tests did -- build a real
   * fixture store with MORE usable rows than the reader's cap, run the real
   * `import-native` command, and read the result back through the real
   * `readSessionTitleOverlay`. No seam is mocked between the importer and
   * the reader; that seam is exactly where the bug lived.
   */
  it('keeps the generated channel readable when the store has more usable rows than the cap', () => {
    const stateDbPath = path.join(homeDirectory, 'state_5.sqlite');
    // Comfortably past `CODEX_NATIVE_TITLE_IMPORT_CAP` (192 today) -- the
    // real host behind #1224 measured 342 usable rows against a 256 cap.
    const totalRows = CODEX_NATIVE_TITLE_IMPORT_CAP + 108;
    const importWhenSeconds = Math.floor(IMPORT_WHEN.getTime() / 1000);
    const rows = Array.from({ length: totalRows }, (_, index) => ({
      id: paddedId('session', index),
      rollout_path: `/home/u/.codex/sessions/rollout-${index}.jsonl`,
      title: `Session ${index}`,
      // Higher index == more recently updated, all inside the recency
      // window -- the cap, not the window, is what's under test.
      updated_at: importWhenSeconds - (totalRows - index) * 60,
    }));
    fixtureCodexDb(stateDbPath, rows);

    const imported = executeSessionTitleAnnotationCommand(
      ['session', 'import-native'],
      {
        homeDirectory,
        env: { AGENT_TELEMETRY_CODEX_STATE_DB: stateDbPath },
        now: () => IMPORT_WHEN,
      },
    );
    expect(imported.ok).toBe(true);

    const overlay = readSessionTitleOverlay(stateDirectory);
    expect(overlay.generated.available).toBe(true);
    expect(overlay.generated.annotations.size).toBeLessThanOrEqual(
      MAX_SESSION_TITLE_ANNOTATION_FILES,
    );
    expect(overlay.generated.annotations.size).toBe(
      CODEX_NATIVE_TITLE_IMPORT_CAP,
    );

    // The retained set is deterministically the most recently updated rows
    // -- the last `CAP` indices inserted, i.e. the newest.
    const expectedIds = new Set(
      Array.from({ length: CODEX_NATIVE_TITLE_IMPORT_CAP }, (_, position) =>
        paddedId('session', totalRows - 1 - position),
      ),
    );
    expect(new Set(overlay.generated.annotations.keys())).toEqual(expectedIds);
  });

  it('stays bounded and holds the newest set after the selected window rotates', () => {
    const stateDbPath = path.join(homeDirectory, 'state_5.sqlite');
    const importWhenSeconds = Math.floor(IMPORT_WHEN.getTime() / 1000);
    const dayInSeconds = 24 * 60 * 60;

    // A first batch, all comfortably inside the 14-day window (around 10
    // days old) -- the current selected set for the first import.
    const firstRows = Array.from(
      { length: CODEX_NATIVE_TITLE_IMPORT_CAP },
      (_, index) => ({
        id: paddedId('first', index),
        rollout_path: `/home/u/.codex/sessions/rollout-first-${index}.jsonl`,
        title: `First ${index}`,
        updated_at: importWhenSeconds - 10 * dayInSeconds - index,
      }),
    );
    fixtureCodexDb(stateDbPath, firstRows);

    const firstImport = executeSessionTitleAnnotationCommand(
      ['session', 'import-native'],
      {
        homeDirectory,
        env: { AGENT_TELEMETRY_CODEX_STATE_DB: stateDbPath },
        now: () => IMPORT_WHEN,
      },
    );
    expect(firstImport.ok).toBe(true);
    const firstOverlay = readSessionTitleOverlay(stateDirectory);
    expect(firstOverlay.generated.available).toBe(true);
    expect(firstOverlay.generated.annotations.size).toBe(
      CODEX_NATIVE_TITLE_IMPORT_CAP,
    );

    // New threads accumulate in the SAME Codex store -- this is the
    // accumulation case #1224 calls out: the importer only ever adds, so
    // even a windowed selection rotates past the cap within a month as
    // fresher rows crowd out the stale ones. A second, entirely disjoint
    // batch, minutes old rather than days old, is unambiguously newer than
    // every row in `firstRows` above.
    const secondRows = Array.from(
      { length: CODEX_NATIVE_TITLE_IMPORT_CAP },
      (_, index) => ({
        id: paddedId('second', index),
        rollout_path: `/home/u/.codex/sessions/rollout-second-${index}.jsonl`,
        title: `Second ${index}`,
        updated_at: importWhenSeconds - index * 60,
      }),
    );
    // Adds to the same on-disk DB from the first call above -- `firstRows`
    // are still there, untouched; this models new threads accumulating
    // rather than a wholesale replace.
    fixtureCodexDb(stateDbPath, secondRows);

    const secondImport = executeSessionTitleAnnotationCommand(
      ['session', 'import-native'],
      {
        homeDirectory,
        env: { AGENT_TELEMETRY_CODEX_STATE_DB: stateDbPath },
        now: () => IMPORT_WHEN,
      },
    );
    expect(secondImport.ok).toBe(true);

    const secondOverlay = readSessionTitleOverlay(stateDirectory);
    expect(secondOverlay.generated.available).toBe(true);
    // Still bounded -- not `2 * CAP`, which is what an add-only importer
    // (the pre-#1224 behaviour) would have accumulated to over these two
    // runs.
    expect(secondOverlay.generated.annotations.size).toBe(
      CODEX_NATIVE_TITLE_IMPORT_CAP,
    );
    // Holds exactly the new set -- every `first-*` final was pruned, every
    // `second-*` final was written.
    const expectedIds = new Set(secondRows.map((row) => row.id));
    expect(new Set(secondOverlay.generated.annotations.keys())).toEqual(
      expectedIds,
    );
  });

  it('never touches a declared annotation while pruning an over-cap generated channel', () => {
    const declaredSessionId = 'declared-session-must-survive';
    const declared = executeSessionTitleAnnotationCommand(
      ['session', 'title', 'A deliberately chosen title'],
      {
        homeDirectory,
        env: { LCARS_SESSION_ID: declaredSessionId },
        now: () => IMPORT_WHEN,
      },
    );
    expect(declared.ok).toBe(true);

    const stateDbPath = path.join(homeDirectory, 'state_5.sqlite');
    const totalRows = CODEX_NATIVE_TITLE_IMPORT_CAP + 40;
    const importWhenSeconds = Math.floor(IMPORT_WHEN.getTime() / 1000);
    const rows = Array.from({ length: totalRows }, (_, index) => ({
      id: paddedId('session', index),
      rollout_path: `/home/u/.codex/sessions/rollout-${index}.jsonl`,
      title: `Session ${index}`,
      updated_at: importWhenSeconds - (totalRows - index) * 60,
    }));
    fixtureCodexDb(stateDbPath, rows);

    const imported = executeSessionTitleAnnotationCommand(
      ['session', 'import-native'],
      {
        homeDirectory,
        env: { AGENT_TELEMETRY_CODEX_STATE_DB: stateDbPath },
        now: () => IMPORT_WHEN,
      },
    );
    expect(imported.ok).toBe(true);

    // The import above genuinely pruned (totalRows > cap), proving this
    // isn't a vacuous "nothing to prune" pass.
    const overlay = readSessionTitleOverlay(stateDirectory);
    expect(overlay.generated.annotations.size).toBe(
      CODEX_NATIVE_TITLE_IMPORT_CAP,
    );

    // The declared title -- a different channel entirely -- must survive
    // untouched, byte-for-byte.
    expect(overlay.declared.available).toBe(true);
    expect(overlay.declared.annotations.get(declaredSessionId)?.title).toBe(
      'A deliberately chosen title',
    );
  });

  it('excludes rows outside the recency window from a real import', () => {
    const stateDbPath = path.join(homeDirectory, 'state_5.sqlite');
    const importWhenSeconds = Math.floor(IMPORT_WHEN.getTime() / 1000);
    const windowSeconds = CODEX_NATIVE_TITLE_RECENCY_WINDOW_DAYS * 24 * 60 * 60;
    fixtureCodexDb(stateDbPath, [
      {
        id: 'too-old',
        rollout_path: '/home/u/.codex/sessions/rollout-too-old.jsonl',
        title: 'Outside the window',
        // One day older than the cutoff -- excluded.
        updated_at: importWhenSeconds - windowSeconds - 24 * 60 * 60,
      },
      {
        id: 'inside-window',
        rollout_path: '/home/u/.codex/sessions/rollout-inside.jsonl',
        title: 'Inside the window',
        updated_at: importWhenSeconds - 60,
      },
    ]);

    const imported = executeSessionTitleAnnotationCommand(
      ['session', 'import-native'],
      {
        homeDirectory,
        env: { AGENT_TELEMETRY_CODEX_STATE_DB: stateDbPath },
        now: () => IMPORT_WHEN,
      },
    );
    expect(imported.ok).toBe(true);

    const overlay = readSessionTitleOverlay(stateDirectory);
    expect(overlay.generated.available).toBe(true);
    expect(Array.from(overlay.generated.annotations.keys())).toEqual([
      'inside-window',
    ]);
  });
});
