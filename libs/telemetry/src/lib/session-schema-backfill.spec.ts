import { describe, expect, it } from 'vitest';

import {
  backfillSessionSchema,
  sessionSchemaBackfillPatch,
  sessionSchemaGaps,
} from './session-schema-backfill';

const repo = { owner: 'jlapenna', name: 'agent-lcars' };

describe('session schema backfill', () => {
  it('reports every required issue-agent metadata gap', () => {
    expect(
      sessionSchemaGaps({ sessionId: 's1', source: 'issue-agent' }),
    ).toEqual(['agent', 'repo', 'renderable']);
  });

  it('backfills only explicit values without provider or repository inference', () => {
    const legacy = {
      sessionId: 's1',
      source: 'issue-agent',
      turns: 2,
      tokens: {},
    };
    expect(
      sessionSchemaBackfillPatch(legacy, {
        sessionId: 's1',
        agent: 'codex',
        repo,
        renderable: true,
      }),
    ).toEqual({ agent: 'codex', repo, renderable: true });
    expect(
      backfillSessionSchema(legacy, {
        sessionId: 's1',
        agent: 'codex',
        repo,
        renderable: true,
      }),
    ).toMatchObject({ agent: 'codex', repo, renderable: true });
  });

  it('rejects missing issue-agent renderability and conflicting stored values', () => {
    expect(() =>
      backfillSessionSchema(
        { sessionId: 's1', source: 'issue-agent' },
        { sessionId: 's1', agent: 'claude-code', repo },
      ),
    ).toThrow('requires explicit renderable');
    expect(() =>
      backfillSessionSchema(
        { sessionId: 's1', source: 'cli', agent: 'codex' },
        { sessionId: 's1', agent: 'claude-code', repo },
      ),
    ).toThrow('conflicting agent');
  });
});
