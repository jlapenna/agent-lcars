import type { SessionDoc } from '@agent-lcars/telemetry';
import { describe, expect, it } from 'vitest';

import { selectResumeSession } from './work-reply';

/** A minimal, valid `IssueAgentSessionDoc` -- every field the type
 *  requires, none of the ones it doesn't. Mirrors `work-router.test.ts`'s
 *  own `sessionDoc` fixture helper. */
function session(over: Partial<SessionDoc> = {}): SessionDoc {
  return {
    source: 'issue-agent',
    sessionId: 's1',
    agent: 'claude-code',
    liveness: 'ended',
    startedAt: '2026-09-04T00:00:00.000Z',
    lastActivityAt: '2026-09-04T00:00:00.000Z',
    turns: 1,
    toolCallCounts: {},
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    repo: { owner: 'octo', name: 'example' },
    intentId: 'work:01ABC/r1',
    transcriptGcsUri: 'gs://b/runs/work:01ABC%2Fr1/claude-code/s1.jsonl',
    renderable: true,
    ...over,
  } as SessionDoc;
}

describe('selectResumeSession', () => {
  const runIds = new Set(['work:01ABC/r1', 'work:01ABC/r2']);

  it('picks the newest session belonging to one of the item runs', () => {
    const older = session({
      sessionId: 'old',
      lastActivityAt: '2026-09-01T00:00:00.000Z',
    });
    const newer = session({
      sessionId: 'new',
      lastActivityAt: '2026-09-03T00:00:00.000Z',
    });
    expect(
      selectResumeSession([older, newer], runIds, 'claude')?.sessionId,
    ).toBe('new');
  });

  it('ignores a session from another item', () => {
    expect(
      selectResumeSession(
        [session({ intentId: 'work:01OTHER/r1' })],
        runIds,
        'claude',
      ),
    ).toBeUndefined();
  });

  it('ignores a session with no archived transcript', () => {
    expect(
      selectResumeSession(
        [session({ transcriptGcsUri: undefined, renderable: undefined })],
        runIds,
        'claude',
      ),
    ).toBeUndefined();
  });

  it('ignores a session whose agent does not match the pipeline', () => {
    expect(
      selectResumeSession([session({ agent: 'codex' })], runIds, 'claude'),
    ).toBeUndefined();
    expect(selectResumeSession([session({})], runIds, 'codex')).toBeUndefined();
  });
});
