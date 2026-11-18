import type { ItemView } from '@agent-lcars/work/derive';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Conversation } from './conversation';

const baseItem: ItemView = {
  id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
  state: 'parked',
  spec: {
    title: 'Add a widget',
    description: 'Add a new UI widget.',
    pipeline: 'claude',
    target: { repo: 'jlapenna/agent-lcars' },
  },
  origin: { principal: 'user:jlapenna', channel: 'api' },
  createdAt: '2026-08-26T10:00:00.000Z',
  updatedAt: '2026-08-26T10:05:00.000Z',
  runs: [],
  sessions: [],
};

const itemWithTwoRounds: ItemView = {
  ...baseItem,
  runs: [
    {
      runId: 'work:x/r1',
      state: 'finished',
      pipeline: 'claude',
      createdAt: '2026-08-26T10:00:00.000Z',
      updatedAt: '2026-08-26T10:05:00.000Z',
      result: {
        ok: true,
        summary: 'park',
        message: 'Which database should I use?',
      },
    },
    {
      runId: 'work:x/r2',
      state: 'finished',
      pipeline: 'claude',
      createdAt: '2026-08-26T10:10:00.000Z',
      updatedAt: '2026-08-26T10:15:00.000Z',
      reply: 'Use Firestore.',
      replyChannel: 'console',
      replyPrincipal: 'user:jlapenna',
      result: {
        ok: true,
        summary: 'park',
        message: 'Confirmed: using Firestore.',
      },
    },
  ],
};

const itemWithLiveRound: ItemView = {
  ...baseItem,
  state: 'running',
  runs: [
    {
      runId: 'work:x/r1',
      state: 'running',
      pipeline: 'claude',
      createdAt: '2026-08-26T10:00:00.000Z',
      updatedAt: '2026-08-26T10:00:00.000Z',
    },
  ],
};

function renderConversation(item: ItemView) {
  render(
    <MantineProvider>
      <Conversation item={item} />
    </MantineProvider>,
  );
}

describe('Conversation', () => {
  it('renders a fresh provider fallback with its original intent and triggering failure', () => {
    const run = itemWithLiveRound.runs[0]!;
    renderConversation({
      ...itemWithLiveRound,
      runs: [
        {
          ...run,
          pipeline: 'codex',
          providerFallback: {
            allowedPipelines: ['codex', 'opencode'],
            attemptedPipelines: ['claude', 'codex'],
            originalRunId: 'work:x/r1',
            fromRunId: 'work:x/r1',
            trigger: {
              reason: 'provider-cooldown',
              failureRunId: 'other/repo#7/r3',
              limitedPipeline: 'claude',
            },
          },
        },
      ],
    });
    expect(
      screen.getByText(/Fresh attempt on codex.*claude is cooling down/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/triggering failure: other\/repo#7\/r3/),
    ).toBeInTheDocument();
  });
  it('renders round one as the spec description and each reply round as a turn pair', () => {
    renderConversation(itemWithTwoRounds);
    // round 1: the human turn is the item's own description
    expect(screen.getByText('Add a new UI widget.')).toBeInTheDocument();
    expect(
      screen.getByText('Which database should I use?'),
    ).toBeInTheDocument();
    // round 2: the reply and the agent's answer
    expect(screen.getByText('Use Firestore.')).toBeInTheDocument();
    expect(screen.getAllByText(/user:jlapenna/).length).toBeGreaterThan(0);
    expect(screen.getByText('Confirmed: using Firestore.')).toBeInTheDocument();
  });

  it('renders a round with no agent message without an empty agent bubble', () => {
    renderConversation(itemWithLiveRound);
    expect(screen.queryByTestId('agent-turn')).not.toBeInTheDocument();
  });
});

it('carries both exact PR and blocker links on the agent turn', () => {
  const ref = 'https://github.com/octo/example/pull/12';
  const blocker = 'https://github.com/octo/example/issues/42#issuecomment-99';
  renderConversation({
    ...baseItem,
    runs: [
      {
        ...itemWithTwoRounds.runs[0],
        result: {
          ok: true,
          summary: 'park',
          message: 'Choose a database.',
          ref,
          relatedRefs: [blocker],
        },
      },
    ],
  });
  expect(
    screen
      .getAllByRole('link', { name: /^(GitHub ref ↗|ref)$/ })
      .map((link) => link.getAttribute('href')),
  ).toEqual([ref, blocker]);
});

it('keeps fallback provenance and exact result links when session access is withheld', () => {
  const originalRunId = 'work:x/r1';
  const runId = 'work:x/r2';
  const ref = 'https://github.com/octo/example/pull/12';
  const blocker = 'https://github.com/octo/example/issues/42#issuecomment-99';
  const item: ItemView = {
    ...baseItem,
    runs: [
      {
        ...itemWithTwoRounds.runs[1]!,
        runId,
        pipeline: 'codex',
        providerFallback: {
          allowedPipelines: ['codex'],
          attemptedPipelines: ['claude', 'codex'],
          originalRunId,
          fromRunId: originalRunId,
          trigger: {
            reason: 'provider-limit',
            limitedPipeline: 'claude',
            failureRunId: originalRunId,
          },
        },
        result: {
          ok: true,
          summary: 'park',
          message: 'Choose a database.',
          ref,
          relatedRefs: [blocker, ref, 'javascript:alert(1)'],
        },
      },
    ],
    sessions: [
      {
        runId,
        sessionId: 'private/session',
        startedAt: '2026-08-26T10:10:00.000Z',
        lastActivityAt: '2026-08-26T10:15:00.000Z',
      },
    ],
  };
  render(
    <MantineProvider>
      <Conversation item={item} canViewSessions={false} />
    </MantineProvider>,
  );
  expect(
    screen.getByText(
      /Fresh attempt on codex.*claude reported a provider limit/,
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      /Original intent: work:x\/r1; previous attempt: work:x\/r1; triggering failure: work:x\/r1/,
    ),
  ).toBeInTheDocument();
  expect(
    screen
      .getAllByRole('link', { name: /^(GitHub ref ↗|ref)$/ })
      .map((link) => link.getAttribute('href')),
  ).toEqual([ref, blocker]);
  expect(screen.queryByRole('link', { name: 'session' })).toBeNull();
});

it("labels a report as the round's result, and only a report", () => {
  renderConversation({
    ...baseItem,
    state: 'done',
    runs: [
      {
        runId: 'work:x/r1',
        state: 'finished',
        pipeline: 'claude',
        createdAt: '2026-08-26T10:00:00.000Z',
        updatedAt: '2026-08-26T10:05:00.000Z',
        result: { ok: true, summary: 'report', message: '# Findings' },
      },
    ],
  });
  expect(screen.getByText('Report')).toBeTruthy();
  expect(screen.getByText('# Findings')).toBeTruthy();
});

it('does not label an ordinary agent turn as a report', () => {
  renderConversation(itemWithTwoRounds);
  expect(screen.queryByText('Report')).toBeNull();
});

describe('run evidence', () => {
  const withEvidence = (
    evidence: NonNullable<ItemView['runs'][number]['evidence']>,
  ): ItemView => ({
    ...baseItem,
    state: 'done',
    runs: [
      {
        runId: 'work:x/r1',
        state: 'finished',
        pipeline: 'claw-default',
        createdAt: '2026-08-26T10:00:00.000Z',
        updatedAt: '2026-08-26T10:05:00.000Z',
        result: { ok: true, summary: 'report', message: 'All clear.' },
        evidence,
      },
    ],
  });
  const show = (item: ItemView) =>
    render(
      <MantineProvider>
        <Conversation item={item} />
      </MantineProvider>,
    );

  it('shows what the worker saw the agent do, under its message', () => {
    show(
      withEvidence({
        source: 'acp',
        harness: 'openclaw',
        stopReason: 'end_turn',
        toolCallCount: 4,
        toolCalls: [
          { kind: 'execute', status: 'completed' },
          { kind: 'read', status: 'failed' },
          { kind: 'execute', status: 'completed' },
          { kind: 'fetch', status: 'in_progress' },
        ],
        usage: {
          inputTokens: 51_000,
          outputTokens: 2_000,
          cachedReadTokens: 40_000,
          totalTokens: 53_000,
          contextTokens: 53_000,
          contextWindow: 200_000,
          cost: { amount: 0.045, currency: 'USD' },
        },
        durationMs: 41_250,
        recordedAt: '2026-08-26T10:05:00.000Z',
      }),
    );
    const [tools, turn] = Array.from(
      screen.getByTestId('run-evidence').children,
      (line) => line.textContent,
    );
    expect(tools).toBe(
      'Tool calls: 4 (execute 2, read 1, fetch 1; 1 failed; 1 unfinished)',
    );
    expect(turn).toBe(
      'Harness: openclaw · Stopped: end_turn · Tokens: 51,000 in, 2,000 out, 40,000 cached · Context: 53,000 of 200,000 · Cost: USD 0.0450 · Turn: 41 s',
    );
  });

  it('says so when a turn called no tool and reported no usage', () => {
    show(
      withEvidence({
        source: 'acp',
        harness: 'codex',
        toolCallCount: 0,
        toolCalls: [],
        recordedAt: '2026-08-26T10:05:00.000Z',
      }),
    );
    const [tools, turn] = Array.from(
      screen.getByTestId('run-evidence').children,
      (line) => line.textContent,
    );
    expect(tools).toBe('Tool calls: none');
    expect(turn).toBe('Harness: codex');
  });

  it('counts every call when a record lists only the first', () => {
    show(
      withEvidence({
        source: 'acp',
        harness: 'claude',
        toolCallCount: 1_250,
        toolCalls: Array.from({ length: 200 }, () => ({
          kind: 'read' as const,
          status: 'completed' as const,
        })),
        recordedAt: '2026-08-26T10:05:00.000Z',
      }),
    );
    expect(screen.getByTestId('run-evidence').children[0]?.textContent).toBe(
      'Tool calls: 1,250 (read 200; first 200 listed)',
    );
  });

  it('rounds nothing small down to nothing', () => {
    show(
      withEvidence({
        source: 'acp',
        harness: 'claude',
        // Counted by a worker that listed none of them.
        toolCallCount: 5,
        toolCalls: [],
        usage: {
          thoughtTokens: 900,
          cachedWriteTokens: 1_200,
          contextWindow: 200_000,
          cost: { amount: 0.00004, currency: 'USD' },
        },
        durationMs: 400,
        recordedAt: '2026-08-26T10:05:00.000Z',
      }),
    );
    const [tools, turn] = Array.from(
      screen.getByTestId('run-evidence').children,
      (line) => line.textContent,
    );
    expect(tools).toBe('Tool calls: 5');
    expect(turn).toBe(
      'Harness: claude · Tokens: 1,200 written to cache, 900 thinking · Context window: 200,000 · Cost: USD under 0.0001 · Turn: 0.4 s',
    );
  });

  it('keeps the total when the breakdown is incomplete, and calls nothing unfinished it cannot tell is', () => {
    show(
      withEvidence({
        source: 'acp',
        harness: 'codex',
        toolCallCount: 3,
        toolCalls: [
          { kind: 'execute', status: 'completed' },
          // A newer harness's word for a status this Console does not know.
          { kind: 'read', status: 'other' },
          { kind: 'read', status: 'pending' },
        ],
        usage: { totalTokens: 120, cachedReadTokens: 20 },
        recordedAt: '2026-08-26T10:05:00.000Z',
      }),
    );
    const [tools, turn] = Array.from(
      screen.getByTestId('run-evidence').children,
      (line) => line.textContent,
    );
    expect(tools).toBe('Tool calls: 3 (execute 1, read 2; 1 unfinished)');
    expect(turn).toBe('Harness: codex · Tokens: 120 total, 20 cached');
  });

  it("shows a total alone as the turn's tokens", () => {
    show(
      withEvidence({
        source: 'acp',
        harness: 'codex',
        toolCallCount: 0,
        toolCalls: [],
        usage: { totalTokens: 53_000 },
        recordedAt: '2026-08-26T10:05:00.000Z',
      }),
    );
    expect(screen.getByTestId('run-evidence').children[1]?.textContent).toBe(
      'Harness: codex · Tokens: 53,000',
    );
  });

  it('shows nothing for a run whose worker reported none', () => {
    show(itemWithTwoRounds);
    expect(screen.queryByTestId('run-evidence')).toBeNull();
  });
});
