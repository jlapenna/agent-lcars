import { describe, expect, it } from 'vitest';

import {
  backfillSessionSchema,
  sessionSchemaBackfillPatch,
  sessionSchemaGaps,
} from './session-schema-backfill';

const repo = { owner: 'jlapenna', name: 'agent-lcars' };

describe('session schema backfill', () => {
  it('does not require or patch renderability on a summary-only issue-agent document', () => {
    expect(
      sessionSchemaGaps({ sessionId: 's1', source: 'issue-agent' }),
    ).toEqual(['agent', 'repo']);
    expect(
      sessionSchemaBackfillPatch(
        { sessionId: 's1', source: 'issue-agent' },
        { sessionId: 's1', agent: 'codex', repo, renderable: true },
      ),
    ).toEqual({ agent: 'codex', repo });
  });

  it('requires and patches renderability only when an issue-agent archive exists', () => {
    const legacy = {
      sessionId: 's1',
      source: 'issue-agent',
      transcriptGcsUri: 'gs://agent-lcars/session.jsonl',
    };
    expect(sessionSchemaGaps(legacy)).toEqual(['agent', 'repo', 'renderable']);
    expect(() =>
      sessionSchemaBackfillPatch(legacy, {
        sessionId: 's1',
        agent: 'codex',
        repo,
      }),
    ).toThrow('requires explicit renderable');
    expect(
      sessionSchemaBackfillPatch(legacy, {
        sessionId: 's1',
        agent: 'codex',
        repo,
        renderable: true,
      }),
    ).toEqual({ agent: 'codex', repo, renderable: true });
  });

  it('requires repository identity for issue-agent anchors but preserves repo-less CLI history', () => {
    expect(
      sessionSchemaGaps({
        sessionId: 's1',
        source: 'infra',
        agent: '',
        repo: { owner: ' ', name: '' },
      }),
    ).toEqual(['source', 'agent', 'repo']);
    expect(
      sessionSchemaGaps({
        sessionId: 's2',
        source: 'cli',
        agent: 'codex',
        repo: { owner: ' jlapenna', name: 'agent-lcars ' },
      }),
    ).toEqual(['repo']);
    expect(
      sessionSchemaGaps({
        sessionId: 's3',
        source: 'cli',
        agent: 'codex',
        repo: { owner: 'o'.repeat(40), name: 'n'.repeat(101) },
      }),
    ).toEqual(['repo']);
    expect(
      sessionSchemaGaps({
        sessionId: 's4',
        source: 'cli',
        agent: 'claude-code',
        host: 'pike',
        lastActivityAt: '',
      }),
    ).toEqual([]);
    expect(
      sessionSchemaGaps({
        sessionId: 's5',
        source: 'issue-agent',
        agent: 'codex',
      }),
    ).toEqual(['repo']);
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
      }),
    ).toEqual({ agent: 'codex', repo });
    expect(
      backfillSessionSchema(legacy, {
        sessionId: 's1',
        agent: 'codex',
        repo,
      }),
    ).toMatchObject({ agent: 'codex', repo });
  });

  it('repairs a repo-less CLI agent without inventing a repository', () => {
    const legacy = { sessionId: 's1', source: 'cli' };
    expect(
      sessionSchemaBackfillPatch(legacy, {
        sessionId: 's1',
        agent: 'claude-code',
      }),
    ).toEqual({ agent: 'claude-code' });
    expect(
      backfillSessionSchema(legacy, {
        sessionId: 's1',
        agent: 'claude-code',
      }),
    ).toMatchObject({ agent: 'claude-code' });
    expect(
      sessionSchemaGaps({
        sessionId: 's1',
        source: 'cli',
        agent: 'claude-code',
      }),
    ).toEqual([]);
  });

  it('rejects missing archived issue-agent renderability, noncanonical repo values, and conflicting stored values', () => {
    expect(() =>
      backfillSessionSchema(
        { sessionId: 's1', source: 'issue-agent' },
        { sessionId: 's1', agent: 'claude-code' },
      ),
    ).toThrow('requires a canonical GitHub repo');
    expect(() =>
      backfillSessionSchema(
        {
          sessionId: 's1',
          source: 'issue-agent',
          transcriptGcsUri: 'gs://agent-lcars/session.jsonl',
        },
        { sessionId: 's1', agent: 'claude-code', repo },
      ),
    ).toThrow('requires explicit renderable');
    expect(() =>
      backfillSessionSchema(
        { sessionId: 's1', source: 'cli' },
        { sessionId: 's1', agent: 'codex', repo: { owner: ' ', name: 'x' } },
      ),
    ).toThrow('requires a canonical GitHub repo');
    expect(() =>
      backfillSessionSchema(
        { sessionId: 's1', source: 'cli' },
        {
          sessionId: 's1',
          agent: 'codex',
          repo: { owner: 'jlapenna', name: 'agent-lcars ' },
        },
      ),
    ).toThrow('requires a canonical GitHub repo');
    expect(() =>
      backfillSessionSchema(
        { sessionId: 's1', source: 'cli', agent: 'codex' },
        { sessionId: 's1', agent: 'claude-code', repo },
      ),
    ).toThrow('conflicting agent');
  });
});
