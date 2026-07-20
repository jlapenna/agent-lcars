import { DatabaseSync } from 'node:sqlite';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseGoTimestamp,
  pollAntigravitySummaries,
} from './antigravity-summary-source';

const GO_ZERO_TIME = '0001-01-01 00:00:00+00:00';

interface FixtureRow {
  conversation_id: string;
  title?: string;
  step_count?: number;
  last_modified_time?: string;
  workspace_uris?: string;
  last_user_input_time?: string;
}

/** Builds a real, on-disk SQLite DB matching the schema discovered against a
 * live Antigravity CLI install (see `antigravity-summary-source.ts`'s
 * header comment) - never synthesizes fake production data, just the shape.
 * Callers own deleting the returned dir (see `afterEach` below). */
function createFixtureDb(rows: FixtureRow[]): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'antigravity-summary-fixture-'),
  );
  const dbPath = path.join(dir, 'conversation_summaries.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id text,
      title text NOT NULL DEFAULT "",
      preview text NOT NULL DEFAULT "",
      step_count integer NOT NULL DEFAULT 0,
      last_modified_time datetime NOT NULL,
      workspace_uris text NOT NULL,
      status text NOT NULL DEFAULT "",
      source text NOT NULL DEFAULT "",
      project_id text NOT NULL DEFAULT "",
      agent_name text NOT NULL DEFAULT "",
      parent_conversation_id text NOT NULL DEFAULT "",
      nesting_depth integer NOT NULL DEFAULT 0,
      battle_id text NOT NULL DEFAULT "",
      winning_conversation_id text NOT NULL DEFAULT "",
      not_fully_idle numeric NOT NULL DEFAULT false,
      killed numeric NOT NULL DEFAULT false,
      last_user_input_time datetime NOT NULL,
      last_user_input_step_index integer NOT NULL DEFAULT -1,
      app_data_dir text NOT NULL DEFAULT "",
      PRIMARY KEY (conversation_id)
    )
  `);
  const insert = db.prepare(`
    INSERT INTO conversation_summaries
      (conversation_id, title, step_count, last_modified_time, workspace_uris, last_user_input_time)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.conversation_id,
      row.title ?? '',
      row.step_count ?? 0,
      row.last_modified_time ?? GO_ZERO_TIME,
      row.workspace_uris ?? '',
      row.last_user_input_time ?? GO_ZERO_TIME,
    );
  }
  db.close();
  return dbPath;
}

const tempDirs: string[] = [];
function trackedFixtureDb(rows: FixtureRow[]): string {
  const dbPath = createFixtureDb(rows);
  tempDirs.push(path.dirname(dbPath));
  return dbPath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('parseGoTimestamp', () => {
  it('parses a real Antigravity timestamp (nanosecond precision, space-separated) to ISO milliseconds', () => {
    expect(parseGoTimestamp('2026-07-01 00:42:40.565799365+00:00')).toBe(
      '2026-07-01T00:42:40.565Z',
    );
  });

  it('parses a timestamp with no fractional seconds', () => {
    expect(parseGoTimestamp('2026-06-22 21:40:35+00:00')).toBe(
      '2026-06-22T21:40:35.000Z',
    );
  });

  it('returns undefined for the Go zero-time sentinel', () => {
    expect(parseGoTimestamp(GO_ZERO_TIME)).toBeUndefined();
  });

  it('returns undefined for a non-string value', () => {
    expect(parseGoTimestamp(undefined)).toBeUndefined();
    expect(parseGoTimestamp(12345)).toBeUndefined();
    expect(parseGoTimestamp(null)).toBeUndefined();
  });

  it('returns undefined for an unparseable string', () => {
    expect(parseGoTimestamp('not a timestamp')).toBeUndefined();
    expect(parseGoTimestamp('2026-07-01T00:42:40.565Z')).toBeUndefined(); // wrong separator (T, not space)
  });
});

describe('pollAntigravitySummaries', () => {
  const MEMBERS_PREFIX = '/home/jlapenna/p/members';

  it('ships a row whose workspace_uris matches the allowlist', () => {
    const dbPath = trackedFixtureDb([
      {
        conversation_id: 'convo-attributable',
        step_count: 42,
        last_modified_time: '2026-07-01 00:42:40.565799365+00:00',
        workspace_uris: JSON.stringify([`file://${MEMBERS_PREFIX}`]),
      },
    ]);

    const summaries = pollAntigravitySummaries(dbPath, [MEMBERS_PREFIX]);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      sessionId: 'convo-attributable',
      source: 'cli',
      agent: 'antigravity',
      cwd: MEMBERS_PREFIX,
      turns: 42,
      startedAt: '2026-07-01T00:42:40.565Z',
      lastActivityAt: '2026-07-01T00:42:40.565Z',
      toolCallCounts: {},
      tokens: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      deliverables: { prNumbers: [], commitShas: [] },
    });
    expect(summaries[0]).not.toHaveProperty('title');
  });

  it('ships a row whose workspace_uris is a worktree subpath of the allowlist', () => {
    const worktreePath = `${MEMBERS_PREFIX}/.claude/worktrees/some-feature`;
    const dbPath = trackedFixtureDb([
      {
        conversation_id: 'convo-worktree',
        last_modified_time: '2026-07-01 00:42:40.565799365+00:00',
        workspace_uris: JSON.stringify([`file://${worktreePath}`]),
      },
    ]);

    const summaries = pollAntigravitySummaries(dbPath, [MEMBERS_PREFIX]);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].cwd).toBe(worktreePath);
  });

  it('drops a row whose workspace_uris points outside the allowlist', () => {
    const dbPath = trackedFixtureDb([
      {
        conversation_id: 'convo-other-project',
        last_modified_time: '2026-07-01 00:42:40.565799365+00:00',
        workspace_uris: JSON.stringify(['file:///home/jlapenna/p/other']),
      },
    ]);

    expect(pollAntigravitySummaries(dbPath, [MEMBERS_PREFIX])).toEqual([]);
  });

  it('does not match a sibling directory that merely shares the allowlist prefix as a string', () => {
    const dbPath = trackedFixtureDb([
      {
        conversation_id: 'convo-sibling',
        last_modified_time: '2026-07-01 00:42:40.565799365+00:00',
        workspace_uris: JSON.stringify([`file://${MEMBERS_PREFIX}2`]),
      },
    ]);

    expect(pollAntigravitySummaries(dbPath, [MEMBERS_PREFIX])).toEqual([]);
  });

  it('drops a row with malformed (non-JSON) workspace_uris', () => {
    const dbPath = trackedFixtureDb([
      {
        conversation_id: 'convo-malformed',
        last_modified_time: '2026-07-01 00:42:40.565799365+00:00',
        workspace_uris: 'not valid json{',
      },
    ]);

    expect(pollAntigravitySummaries(dbPath, [MEMBERS_PREFIX])).toEqual([]);
  });

  it('drops a row with empty-string workspace_uris (observed on 32/221 real rows)', () => {
    const dbPath = trackedFixtureDb([
      {
        conversation_id: 'convo-empty-workspace',
        last_modified_time: '2026-07-01 00:42:40.565799365+00:00',
        workspace_uris: '',
      },
    ]);

    expect(pollAntigravitySummaries(dbPath, [MEMBERS_PREFIX])).toEqual([]);
  });

  it('drops a row whose last_modified_time is unparseable/the Go zero sentinel', () => {
    const dbPath = trackedFixtureDb([
      {
        conversation_id: 'convo-no-activity',
        last_modified_time: GO_ZERO_TIME,
        workspace_uris: JSON.stringify([`file://${MEMBERS_PREFIX}`]),
      },
    ]);

    expect(pollAntigravitySummaries(dbPath, [MEMBERS_PREFIX])).toEqual([]);
  });

  it('falls back startedAt to lastActivityAt when last_user_input_time is the Go zero sentinel', () => {
    const dbPath = trackedFixtureDb([
      {
        conversation_id: 'convo-no-user-input',
        last_modified_time: '2026-07-01 00:42:40.565799365+00:00',
        last_user_input_time: GO_ZERO_TIME,
        workspace_uris: JSON.stringify([`file://${MEMBERS_PREFIX}`]),
      },
    ]);

    const summaries = pollAntigravitySummaries(dbPath, [MEMBERS_PREFIX]);

    expect(summaries[0].startedAt).toBe(summaries[0].lastActivityAt);
  });

  it('uses last_user_input_time as startedAt when it is a real (non-zero) timestamp', () => {
    const dbPath = trackedFixtureDb([
      {
        conversation_id: 'convo-real-user-input',
        last_modified_time: '2026-07-01 00:42:40.565799365+00:00',
        last_user_input_time: '2026-06-30 12:00:00+00:00',
        workspace_uris: JSON.stringify([`file://${MEMBERS_PREFIX}`]),
      },
    ]);

    const summaries = pollAntigravitySummaries(dbPath, [MEMBERS_PREFIX]);

    expect(summaries[0].startedAt).toBe('2026-06-30T12:00:00.000Z');
    expect(summaries[0].lastActivityAt).toBe('2026-07-01T00:42:40.565Z');
  });

  it('includes a title only when the row has a non-empty one', () => {
    const dbPath = trackedFixtureDb([
      {
        conversation_id: 'convo-titled',
        title: 'Fix the flaky test',
        last_modified_time: '2026-07-01 00:42:40.565799365+00:00',
        workspace_uris: JSON.stringify([`file://${MEMBERS_PREFIX}`]),
      },
    ]);

    const summaries = pollAntigravitySummaries(dbPath, [MEMBERS_PREFIX]);

    expect(summaries[0].title).toBe('Fix the flaky test');
  });

  it('drops a row with no conversation_id', () => {
    const dbPath = trackedFixtureDb([
      {
        conversation_id: '',
        last_modified_time: '2026-07-01 00:42:40.565799365+00:00',
        workspace_uris: JSON.stringify([`file://${MEMBERS_PREFIX}`]),
      },
    ]);

    expect(pollAntigravitySummaries(dbPath, [MEMBERS_PREFIX])).toEqual([]);
  });

  it('ships attributable rows and drops non-members rows from the same DB', () => {
    const dbPath = trackedFixtureDb([
      {
        conversation_id: 'convo-a',
        last_modified_time: '2026-07-01 00:42:40.565799365+00:00',
        workspace_uris: JSON.stringify([`file://${MEMBERS_PREFIX}`]),
      },
      {
        conversation_id: 'convo-b',
        last_modified_time: '2026-06-22 21:40:35+00:00',
        workspace_uris: JSON.stringify(['file:///home/jlapenna/p/onecake']),
      },
    ]);

    const summaries = pollAntigravitySummaries(dbPath, [MEMBERS_PREFIX]);

    expect(summaries.map((s) => s.sessionId)).toEqual(['convo-a']);
  });

  it('fails soft and reports unavailability when the DB file does not exist', () => {
    const missingPath = path.join(
      os.tmpdir(),
      'antigravity-summary-does-not-exist',
      'conversation_summaries.db',
    );
    const errors: unknown[] = [];

    const summaries = pollAntigravitySummaries(missingPath, [MEMBERS_PREFIX], {
      onUnavailable: (error) => errors.push(error),
    });

    expect(summaries).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('fails soft and reports unavailability when the DB file is not a real SQLite database', () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'antigravity-summary-garbage-'),
    );
    tempDirs.push(dir);
    const garbagePath = path.join(dir, 'conversation_summaries.db');
    fs.writeFileSync(garbagePath, 'definitely not a sqlite database');
    const errors: unknown[] = [];

    const summaries = pollAntigravitySummaries(garbagePath, [MEMBERS_PREFIX], {
      onUnavailable: (error) => errors.push(error),
    });

    expect(summaries).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('defaults the allowlist to the members repo prefix when none is passed', () => {
    const dbPath = trackedFixtureDb([
      {
        conversation_id: 'convo-default-allowlist',
        last_modified_time: '2026-07-01 00:42:40.565799365+00:00',
        workspace_uris: JSON.stringify([`file://${MEMBERS_PREFIX}`]),
      },
    ]);

    const summaries = pollAntigravitySummaries(dbPath);

    expect(summaries).toHaveLength(1);
  });
});
