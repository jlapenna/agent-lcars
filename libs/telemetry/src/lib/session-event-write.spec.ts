import { describe, expect, it } from 'vitest';

import { parseSessionEventV1 } from './session-event';
import { isNewerHookWrite, sessionWriteForEvent } from './session-event-write';
import { type SessionDoc } from './types';

const NOW = '2026-10-12T12:00:00.000Z';
const summary = {
  sessionId: 'sess-1',
  source: 'cli',
  agent: 'claude-code',
  startedAt: '2026-10-12T10:00:00.000Z',
  lastActivityAt: '2026-10-12T11:59:00.000Z',
  turns: 3,
  toolCallCounts: { Bash: 2 },
  tokens: {
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 5,
  },
  deliverables: { prNumbers: [], commitShas: [] },
  repo: { owner: 'jlapenna', name: 'agent-lcars' },
};
function event(overrides: Record<string, unknown> = {}) {
  const parsed = parseSessionEventV1({
    version: 1,
    eventId: 'evt-1',
    seq: 2,
    occurredAt: NOW,
    host: 'laforge',
    agent: 'claude-code',
    sessionId: 'sess-1',
    kind: 'tool',
    runtime: {
      name: 'claude-code',
      hookEvent: 'PostToolUse',
      clientVersion: '0.3.0',
    },
    summary,
    ...overrides,
  });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.event;
}
const observer = {
  kind: 'hook' as const,
  runtime: 'claude-code' as const,
  host: 'laforge',
  seq: 5,
  eventId: 'e5',
  occurredAt: NOW,
};

describe('sessionWriteForEvent', () => {
  it('preserves observed actor in a lifecycle-only end event and clears it on a failed refresh', () => {
    const existing = sessionWriteForEvent(
      event({ summary: { ...summary, githubActor: 'jlapenna' } }),
      undefined,
      NOW,
    )!.doc;
    const ending = sessionWriteForEvent(
      event({ summary: undefined, kind: 'end' }),
      existing,
      NOW,
    );
    expect(ending?.doc).toMatchObject({
      githubActor: 'jlapenna',
      liveness: 'ended',
    });
    expect(ending?.clearFields).not.toContain('githubActor');
    const unavailable = sessionWriteForEvent(event(), existing, NOW);
    expect(unavailable?.doc).not.toHaveProperty('githubActor');
    expect(unavailable?.clearFields).toContain('githubActor');
  });

  it('builds a live cli doc with hook provenance', () => {
    const write = sessionWriteForEvent(event(), undefined, NOW);
    expect(write?.doc).toMatchObject({
      source: 'cli',
      liveness: 'live',
      observedAt: NOW,
      host: 'laforge',
      observer: {
        kind: 'hook',
        host: 'laforge',
        seq: 2,
        clientVersion: '0.3.0',
      },
    });
  });

  it('maps stop and end, and never trusts the summary source', () => {
    expect(
      sessionWriteForEvent(event({ kind: 'stop' }), undefined, NOW)?.doc
        .liveness,
    ).toBe('idle');
    expect(
      sessionWriteForEvent(event({ kind: 'end' }), undefined, NOW)?.doc
        .liveness,
    ).toBe('ended');
    expect(
      sessionWriteForEvent(
        event({ summary: { ...summary, source: 'issue-agent' } }),
        undefined,
        NOW,
      )?.doc.source,
    ).toBe('cli');
  });

  it('uses runner context for issue-agent docs', () => {
    const runner = {
      runId: 'run-1',
      issueNumber: 5,
      repo: { owner: 'jlapenna', name: 'agent-lcars' },
    };
    expect(
      sessionWriteForEvent(event({ runner }), undefined, NOW)?.doc,
    ).toMatchObject({
      source: 'issue-agent',
      runId: 'run-1',
      issueNumber: 5,
    });
  });

  it('applies a lifecycle-only event on top of the stored doc, or not at all without one', () => {
    const stored = {
      sessionId: 'sess-1',
      source: 'cli',
      agent: 'claude-code',
      liveness: 'live',
      startedAt: summary.startedAt,
      lastActivityAt: summary.lastActivityAt,
      turns: 7,
      toolCallCounts: {},
      tokens: summary.tokens,
      deliverables: summary.deliverables,
      title: 'kept',
      branch: 'main',
    } as SessionDoc;
    const { summary: _omit, ...lifecycle } = { ...event({ kind: 'end' }) };
    expect(sessionWriteForEvent(lifecycle, stored, NOW)?.doc).toMatchObject({
      liveness: 'ended',
      turns: 7,
      title: 'kept',
      branch: 'main',
    });
    expect(sessionWriteForEvent(lifecycle, undefined, NOW)).toBeUndefined();
  });
});

describe('sessionWriteForEvent token minutes', () => {
  it('records the tokens this event added to the stored doc', () => {
    const stored = sessionWriteForEvent(event(), undefined, NOW)?.doc;
    expect(stored?.tokenMinutes).toEqual([]);
    const grown = event({
      summary: { ...summary, tokens: { ...summary.tokens, outputTokens: 120 } },
    });
    expect(
      sessionWriteForEvent(grown, stored as SessionDoc, NOW)?.doc.tokenMinutes,
    ).toEqual([{ minute: '2026-10-12T12:00:00.000Z', tokens: 100 }]);
  });
});

describe('sessionWriteForEvent archive preservation', () => {
  it('keeps the daemon-recorded transcript archive on a hook write', () => {
    const stored = {
      sessionId: 'sess-1',
      source: 'cli',
      agent: 'claude-code',
      liveness: 'live',
      startedAt: summary.startedAt,
      lastActivityAt: summary.lastActivityAt,
      turns: 2,
      toolCallCounts: {},
      tokens: summary.tokens,
      deliverables: summary.deliverables,
      cliTranscriptArchive: {
        status: 'available',
        expiresAt: '2026-11-11T00:00:00.000Z',
      },
      transcriptGcsUri: 'gs://bucket/sess-1.jsonl',
      renderable: true,
    } as unknown as SessionDoc;
    const write = sessionWriteForEvent(event(), stored, NOW);
    expect(write?.doc).toMatchObject({
      cliTranscriptArchive: { status: 'available' },
      transcriptGcsUri: 'gs://bucket/sess-1.jsonl',
      renderable: true,
    });
    expect(write?.clearFields).not.toContain('transcriptGcsUri');
    expect(write?.clearFields).not.toContain('cliTranscriptArchive');
  });
});

describe('isNewerHookWrite', () => {
  it('refuses an equal or older seq from the same host', () => {
    expect(isNewerHookWrite({ ...observer, seq: 5 }, observer)).toBe(false);
    expect(isNewerHookWrite({ ...observer, seq: 9 }, observer)).toBe(false);
  });

  it('applies a newer seq, another host, a non-hook writer, or no stored observer', () => {
    expect(isNewerHookWrite({ ...observer, seq: 4 }, observer)).toBe(true);
    expect(
      isNewerHookWrite({ ...observer, host: 'janeway', seq: 99 }, observer),
    ).toBe(true);
    expect(
      isNewerHookWrite({ kind: 'daemon', host: 'laforge', seq: 99 }, observer),
    ).toBe(true);
    expect(isNewerHookWrite(undefined, observer)).toBe(true);
    expect(isNewerHookWrite({ ...observer, seq: 9 }, undefined)).toBe(true);
  });
});
