import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentRun } from '../../lib/agent-activity';
import type { ExecutionAttempt, LogicalWork } from '../../lib/logical-work';
import { LogicalWorkCard } from './logical-work-card';

// Mirrors agent-activity-panel.test.tsx's own mock of this module: it pulls
// in the server-only GitHub client at import time (assertNotBrowser()),
// which fails immediately under jsdom - see that file's identical comment.
// agent-activity.test.ts is the source of truth for the real behavior of
// these pure helpers/constants; kept in sync by hand. `RUN_TIMEOUT_MINUTES`
// is needed transitively - run-classification.ts's `classifyAgentRun` (used
// by this card's per-attempt badge) reads it from this module.
vi.mock('../../lib/agent-activity', () => ({
  RUN_TIMEOUT_MINUTES: 90,
  displayRunTitle: (run: AgentRun) =>
    run.pipeline === 'opencode'
      ? run.displayTitle.replace(/^opencode\s+/, '')
      : run.displayTitle,
  issueUrlForRun: (run: AgentRun) =>
    run.issueNumber === undefined
      ? undefined
      : `https://github.com/${run.repo.owner}/${run.repo.name}/issues/${run.issueNumber}`,
}));

const REPO = { owner: 'supersprinklesracing', name: 'sprinkles' };

function makeAttempt(
  overrides: Partial<ExecutionAttempt> = {},
): ExecutionAttempt {
  return {
    id: 1,
    repo: REPO,
    pipeline: 'claude',
    status: 'running',
    event: 'workflow_dispatch',
    url: 'https://github.com/o/r/actions/runs/1',
    displayTitle: '#42: Claude issue agent [dispatch:g1:intent-abc]',
    issueNumber: 42,
    createdAt: '2026-07-07T00:00:00Z',
    updatedAt: '2026-07-07T00:00:00Z',
    elapsedSeconds: 90,
    attribution: 'ledger',
    generation: 1,
    intentId: 'intent-abc',
    ...overrides,
  };
}

function makeWork(overrides: Partial<LogicalWork> = {}): LogicalWork {
  return {
    task: { repository: REPO, issueNumber: 42 },
    title: 'Fix the thing',
    url: 'https://github.com/supersprinklesracing/sprinkles/issues/42',
    selectedPipeline: 'claude',
    state: 'active',
    intents: [
      {
        intentId: 'intent-abc',
        generation: 1,
        sourceKind: 'labeled',
        occurredAt: '2026-07-07T00:00:00Z',
        pipeline: 'claude',
        mode: 'implement',
        state: 'active',
      },
    ],
    attempts: [makeAttempt()],
    anomalies: [],
    provenance: { kind: 'ledger-v1', revision: 3 },
    ...overrides,
  };
}

function renderCard(
  work: LogicalWork = makeWork(),
  anchorState: 'open' | 'closed' = 'open',
) {
  render(
    <MantineProvider>
      <LogicalWorkCard work={work} anchorState={anchorState} />
    </MantineProvider>,
  );
}

describe('LogicalWorkCard', () => {
  it('renders the task title, number, and canonical GitHub link', () => {
    renderCard();
    const title = screen.getByText(/#42 Fix the thing/);
    expect(title.closest('a')?.getAttribute('href')).toBe(
      'https://github.com/supersprinklesracing/sprinkles/issues/42',
    );
  });

  it('shows the logical state distinctly from the GitHub anchor state', () => {
    renderCard(makeWork({ state: 'active' }), 'open');
    expect(screen.getByTestId('logical-work-state').textContent).toBe('active');
    expect(screen.getByText('open')).toBeTruthy();
  });

  it('renders anchorState closed for a task whose GitHub issue has closed', () => {
    renderCard(makeWork(), 'closed');
    expect(screen.getByText('closed')).toBeTruthy();
  });

  it('lists every execution attempt, never collapsing duplicates', () => {
    renderCard(
      makeWork({
        attempts: [
          makeAttempt({ id: 1, status: 'queued' }),
          makeAttempt({ id: 2, status: 'running' }),
        ],
      }),
    );
    const attempts = screen.getByTestId('logical-work-attempts');
    expect(within(attempts).getByTestId('logical-work-attempt-1')).toBeTruthy();
    expect(within(attempts).getByTestId('logical-work-attempt-2')).toBeTruthy();
  });

  it('shows a queued attempt as queued, not running (Codex review on #375)', () => {
    renderCard(
      makeWork({
        attempts: [makeAttempt({ id: 1, status: 'queued' })],
      }),
    );
    const attempt = screen.getByTestId('logical-work-attempt-1');
    expect(within(attempt).getByText('queued')).toBeTruthy();
    expect(within(attempt).queryByText('running')).toBeNull();
  });

  it('distinguishes a failed completed attempt from a successful one, not just "completed"', () => {
    renderCard(
      makeWork({
        attempts: [
          makeAttempt({
            id: 1,
            status: 'completed',
            conclusion: 'failure',
            elapsedSeconds: 120,
          }),
        ],
      }),
    );
    const attempt = screen.getByTestId('logical-work-attempt-1');
    expect(within(attempt).getByText('failed')).toBeTruthy();
    expect(within(attempt).queryByText('completed')).toBeNull();
  });

  it('distinguishes a timed-out completed attempt from an ordinary cancel', () => {
    renderCard(
      makeWork({
        attempts: [
          makeAttempt({
            id: 1,
            status: 'completed',
            conclusion: 'cancelled',
            // >=95% of the 90-minute claude.yml/opencode.yml wall-clock
            // budget - classifyAgentRun's own "almost certainly a timeout
            // kill" heuristic (see run-status-classifier.ts).
            elapsedSeconds: 90 * 60,
          }),
        ],
      }),
    );
    const attempt = screen.getByTestId('logical-work-attempt-1');
    expect(within(attempt).getByText('timeout')).toBeTruthy();
  });

  it('renders each dispatch intent with its generation and source kind', () => {
    renderCard();
    const intents = screen.getByTestId('logical-work-intents');
    expect(within(intents).getByText('g1')).toBeTruthy();
    expect(within(intents).getByText('via labeled')).toBeTruthy();
  });

  it('renders broker outcomes separately from the workflow conclusion', () => {
    renderCard(
      makeWork({
        intents: [
          {
            ...makeWork().intents[0],
            state: 'completed',
            outcome: 'no-op',
          },
        ],
        attempts: [
          makeAttempt({
            status: 'completed',
            conclusion: 'failure',
            outcome: 'startup-failure',
          }),
        ],
      }),
    );

    const intents = screen.getByTestId('logical-work-intents');
    expect(within(intents).getByText('no-op')).toBeTruthy();
    const attempt = screen.getByTestId('logical-work-attempt-1');
    expect(within(attempt).getByText('failed')).toBeTruthy();
    expect(within(attempt).getByText('startup failure')).toBeTruthy();
  });

  it('auto-opens the intent disclosure when the task carries an anomaly', () => {
    renderCard(
      makeWork({
        state: 'anomaly',
        anomalies: [
          {
            kind: 'duplicate-active-attempts',
            detail: '2 claude attempts live',
          },
        ],
      }),
    );
    const intents = screen.getByTestId(
      'logical-work-intents',
    ) as HTMLDetailsElement;
    expect(intents.open).toBe(true);
  });

  it('renders every anomaly as a visible alert (never a silent collapse)', () => {
    renderCard(
      makeWork({
        state: 'anomaly',
        anomalies: [
          {
            kind: 'duplicate-active-attempts',
            detail: '2 claude attempts live',
          },
        ],
      }),
    );
    expect(screen.getByTestId('logical-work-anomalies').textContent).toContain(
      '2 claude attempts live',
    );
  });

  it('renders no anomaly alerts for an ordinary task', () => {
    renderCard();
    expect(screen.queryByTestId('logical-work-anomalies')).toBeNull();
  });

  it('shows a legacy-provenance note when no authoritative state backs the task', () => {
    renderCard(
      makeWork({
        provenance: { kind: 'legacy' },
        intents: [],
      }),
    );
    expect(screen.getByText(/no authoritative lifecycle state/)).toBeTruthy();
  });

  it('renders a friendly empty state when a task has zero attempts', () => {
    renderCard(makeWork({ attempts: [], state: 'pending' }));
    expect(
      screen.getByText('No workflow runs attributed to this task yet.'),
    ).toBeTruthy();
  });
});
