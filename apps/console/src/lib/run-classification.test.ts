import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';
import { describe, expect, it } from 'vitest';

import type { AgentRun } from './agent-activity';
import {
  classifyAgentRun,
  deriveSilentErrorDiagnoses,
  indexSessionsByNumericRunId,
} from './run-classification';

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 1,
    repo: { owner: 'supersprinklesracing', name: 'members' },
    pipeline: 'claude',
    status: 'completed',
    conclusion: 'success',
    event: 'issues',
    url: 'https://github.com/o/r/actions/runs/1',
    displayTitle: '#42: Fix the thing',
    issueNumber: 42,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:05:00.000Z',
    elapsedSeconds: 300,
    ...overrides,
  };
}

function makeSessionDoc(
  overrides: Partial<IssueAgentSessionDoc> = {},
): IssueAgentSessionDoc {
  return {
    sessionId: 'session-1',
    source: 'issue-agent',
    liveness: 'ended',
    startedAt: '2026-07-18T00:00:00.000Z',
    lastActivityAt: '2026-07-18T00:05:00.000Z',
    turns: 5,
    toolCallCounts: {},
    tokens: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [42], commitShas: [] },
    runId: '1',
    issueNumber: 42,
    ...overrides,
  };
}

describe('classifyAgentRun', () => {
  it('classifies as succeeded with no diagnosis when no session is joined', () => {
    expect(classifyAgentRun(makeRun())).toEqual({
      status: 'succeeded',
      diagnosis: undefined,
    });
  });

  it('feeds RUN_TIMEOUT_MINUTES into the classifier so a near-budget cancel reads as timeout', () => {
    const result = classifyAgentRun(
      makeRun({ conclusion: 'cancelled', elapsedSeconds: 90 * 60 }),
    );
    expect(result.status).toBe('timeout');
  });

  it('flags silent-error when the joined session shows an error result (e.g. max-turns exhaustion)', () => {
    const result = classifyAgentRun(
      makeRun(),
      makeSessionDoc({ result: { subtype: 'error_max_turns', isError: true } }),
    );
    expect(result.status).toBe('silent-error');
    expect(result.diagnosis).toContain('failure signature');
  });

  it('flags silent-error when the joined session recorded zero turns', () => {
    const result = classifyAgentRun(makeRun(), makeSessionDoc({ turns: 0 }));
    expect(result.status).toBe('silent-error');
  });

  it('does not flag a normal successful session with no PR/commit recorded (e.g. a comment-only reply)', () => {
    const result = classifyAgentRun(
      makeRun(),
      makeSessionDoc({ deliverables: { prNumbers: [], commitShas: [] } }),
    );
    expect(result.status).toBe('succeeded');
  });
});

describe('deriveSilentErrorDiagnoses', () => {
  it('maps a silent-error run to its issue number', () => {
    const run = makeRun({ id: 7, issueNumber: 42 });
    const sessionsByRunId = new Map([
      [
        '7',
        makeSessionDoc({
          result: { subtype: 'error_during_execution', isError: true },
          totalCostUsd: 0,
        }),
      ],
    ]);

    const diagnoses = deriveSilentErrorDiagnoses([run], sessionsByRunId);

    expect(diagnoses.get('supersprinklesracing/members#42')).toContain(
      'failure signature',
    );
  });

  it('skips runs with no parsed issueNumber', () => {
    const run = makeRun({ id: 7, issueNumber: undefined });
    const sessionsByRunId = new Map([
      [
        '7',
        makeSessionDoc({ deliverables: { prNumbers: [], commitShas: [] } }),
      ],
    ]);

    expect(deriveSilentErrorDiagnoses([run], sessionsByRunId).size).toBe(0);
  });

  it('produces nothing for a genuinely successful run', () => {
    const run = makeRun({ id: 7, issueNumber: 42 });
    const sessionsByRunId = new Map([['7', makeSessionDoc()]]);

    expect(deriveSilentErrorDiagnoses([run], sessionsByRunId).size).toBe(0);
  });

  it('produces nothing when no session is joined at all', () => {
    const run = makeRun({ id: 7, issueNumber: 42 });
    expect(deriveSilentErrorDiagnoses([run], new Map()).size).toBe(0);
  });
});

describe('indexSessionsByNumericRunId', () => {
  it('joins by String(run.id) against the runId-keyed map', () => {
    const runs = [makeRun({ id: 1 }), makeRun({ id: 2 })];
    const sessionsByRunId = new Map([
      ['1', makeSessionDoc({ sessionId: 'a' })],
    ]);

    const result = indexSessionsByNumericRunId(runs, sessionsByRunId);

    expect(result[1]?.sessionId).toBe('a');
    expect(result[2]).toBeUndefined();
  });
});
