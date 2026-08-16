import { DatabaseSync } from 'node:sqlite';

import {
  applySessionTitleOverlay,
  SessionSummary,
} from '@agent-lcars/telemetry';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeSessionTitleAnnotationCommand } from './session-title-annotation-command';
import { readSessionTitleOverlay } from './session-title-annotation-source';
import { SESSION_STATE_DIRECTORY } from './session-title-paths';

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
    database.exec(
      `INSERT INTO threads VALUES ('${codexSessionId}',
       '/home/u/.codex/sessions/2026/08/15/rollout-${codexSessionId}.jsonl',
       NULL, 'Investigate accidentally closed GitHub issues', '/home/u/p', 1)`,
    );
    database.close();

    const imported = executeSessionTitleAnnotationCommand(
      ['session', 'import-native'],
      {
        homeDirectory,
        env: { AGENT_TELEMETRY_CODEX_STATE_DB: stateDbPath },
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
    database.exec(
      `INSERT INTO threads VALUES ('${sessionId}', '/r/${sessionId}.jsonl',
       NULL, 'Codex auto-generated label', '/home/u/p', 1)`,
    );
    database.close();

    executeSessionTitleAnnotationCommand(['session', 'import-native'], {
      homeDirectory,
      env: { AGENT_TELEMETRY_CODEX_STATE_DB: stateDbPath },
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
});
