import { describe, expect, it } from 'vitest';

import {
  livenessForSessionEvent,
  parseSessionEventV1,
  parseSessionSummaryV1,
  SESSION_EVENT_KINDS,
} from './session-event';

const summary = {
  sessionId: 'sess-1',
  source: 'cli',
  agent: 'claude-code',
  startedAt: '2026-10-10T10:00:00.000Z',
  lastActivityAt: '2026-10-10T10:05:00.000Z',
  turns: 3,
  toolCallCounts: { Bash: 2 },
  tokens: {
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 5,
  },
  deliverables: { prNumbers: [12], commitShas: ['abcdef1'] },
  host: 'laforge',
  cwd: '/home/jlapenna/p/agent-lcars',
  repo: { owner: 'jlapenna', name: 'agent-lcars' },
  title: 'Land session titles',
  status: 'waiting on CI',
  statusUpdatedAt: '2026-10-10T10:04:00.000Z',
};

const event = {
  version: 1,
  eventId: 'evt-1',
  seq: 4,
  occurredAt: '2026-10-10T10:05:01.000Z',
  host: 'laforge',
  agent: 'claude-code',
  sessionId: 'sess-1',
  kind: 'tool',
  runtime: {
    name: 'claude-code',
    hookEvent: 'PostToolUse',
    clientVersion: '1',
  },
  summary,
};

describe('parseSessionEventV1', () => {
  it('accepts a well-formed event and copies only known fields', () => {
    const result = parseSessionEventV1({
      ...event,
      extra: 'ignored',
      summary: { ...summary, injected: { admin: true } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).not.toHaveProperty('extra');
    expect(result.event.summary).not.toHaveProperty('injected');
    expect(result.event.summary?.repo).toEqual({
      owner: 'jlapenna',
      name: 'agent-lcars',
    });
    expect(result.event.summary?.status).toBe('waiting on CI');
  });

  it.each([
    ['version', { version: 2 }, 'unsupported event version'],
    ['eventId', { eventId: '../x' }, 'eventId must be a safe identifier'],
    ['seq', { seq: 0 }, 'seq must be a positive integer'],
    [
      'occurredAt',
      { occurredAt: 'yesterday' },
      'occurredAt must be an ISO timestamp',
    ],
    ['host', { host: 'la forge' }, 'host must be a safe identifier'],
    ['agent', { agent: 'cursor' }, 'agent is not a known session agent'],
    ['kind', { kind: 'attention' }, 'kind is not a known event kind'],
    [
      'runtime',
      { runtime: { name: 'codex' } },
      'runtime.name must match agent',
    ],
  ])('rejects a malformed %s', (_field, override, reason) => {
    const result = parseSessionEventV1({ ...event, ...override });
    expect(result).toEqual({ ok: false, reason });
  });

  it('rejects a summary for a different session or agent', () => {
    expect(
      parseSessionEventV1({
        ...event,
        summary: { ...summary, sessionId: 'other' },
      }),
    ).toEqual({ ok: false, reason: 'summary is malformed' });
    expect(
      parseSessionEventV1({
        ...event,
        summary: { ...summary, agent: 'codex' },
      }),
    ).toEqual({ ok: false, reason: 'summary.agent must match agent' });
  });

  it('accepts an event without a summary', () => {
    const { summary: _omit, ...lifecycleOnly } = event;
    const result = parseSessionEventV1({ ...lifecycleOnly, kind: 'end' });
    expect(result.ok).toBe(true);
    expect(result.ok ? result.event.summary : 'not ok').toBeUndefined();
  });

  it('validates runner context', () => {
    const runner = {
      runId: 'run-1',
      intentId: 'intent-1',
      issueNumber: 42,
      repo: { owner: 'jlapenna', name: 'agent-lcars' },
    };
    const ok = parseSessionEventV1({ ...event, runner });
    expect(ok.ok && ok.event.runner).toEqual(runner);
    expect(
      parseSessionEventV1({ ...event, runner: { ...runner, repo: {} } }),
    ).toEqual({ ok: false, reason: 'runner context is malformed' });
  });
});

describe('parseSessionSummaryV1', () => {
  it('requires the reducer core fields', () => {
    const { tokens: _omit, ...withoutTokens } = summary;
    expect(parseSessionSummaryV1(withoutTokens, 'sess-1')).toBeUndefined();
    expect(
      parseSessionSummaryV1({ ...summary, turns: -1 }, 'sess-1'),
    ).toBeUndefined();
  });

  it('drops malformed optional fields instead of failing', () => {
    const parsed = parseSessionSummaryV1(
      {
        ...summary,
        repo: { owner: 'bad owner', name: 'x' },
        statusUpdatedAt: 'not-a-date',
        lastToolCall: { name: 'Bash' },
        title: 'x'.repeat(500),
      },
      'sess-1',
    );
    expect(parsed?.repo).toBeUndefined();
    expect(parsed?.status).toBeUndefined();
    expect(parsed?.lastToolCall).toBeUndefined();
    expect(parsed?.title?.length).toBeLessThanOrEqual(80);
  });

  it('rejects non-SHA commit evidence and non-positive PR numbers', () => {
    expect(
      parseSessionSummaryV1(
        { ...summary, deliverables: { prNumbers: [0], commitShas: [] } },
        'sess-1',
      ),
    ).toBeUndefined();
    expect(
      parseSessionSummaryV1(
        { ...summary, deliverables: { prNumbers: [], commitShas: ['zz'] } },
        'sess-1',
      ),
    ).toBeUndefined();
  });
});

describe('livenessForSessionEvent', () => {
  it('maps every kind', () => {
    const expected: Record<string, string> = {
      start: 'live',
      prompt: 'live',
      tool: 'live',
      heartbeat: 'live',
      stop: 'idle',
      end: 'ended',
    };
    for (const kind of SESSION_EVENT_KINDS) {
      expect(livenessForSessionEvent(kind)).toBe(expected[kind]);
    }
  });
});
