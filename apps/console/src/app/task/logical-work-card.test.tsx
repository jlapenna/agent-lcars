import type { Run as OrchestratorRun } from '@agent-lcars/orchestrator';
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
    attribution: 'run-marker',
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
    attempts: [makeAttempt()],
    anomalies: [],
    provenance: { kind: 'authoritative-v1', revision: 3 },
    ...overrides,
  };
}

function makeRun(overrides: Partial<OrchestratorRun> = {}): OrchestratorRun {
  return {
    runId: 'supersprinklesracing/sprinkles#42/r1',
    task: { repo: 'supersprinklesracing/sprinkles', issue: 42 },
    state: 'running',
    pipeline: 'claude',
    requestId: 'req-1',
    leaseExpiresAt: '2026-07-07T02:00:00Z',
    events: [{ at: '2026-07-07T00:00:00Z', to: 'pending', by: 'request' }],
    createdAt: '2026-07-07T00:00:00Z',
    updatedAt: '2026-07-07T00:00:00Z',
    ...overrides,
  };
}

function renderCard(
  work: LogicalWork = makeWork(),
  anchorState: 'open' | 'closed' = 'open',
  runs: OrchestratorRun[] = [],
) {
  render(
    <MantineProvider>
      <LogicalWorkCard work={work} runs={runs} anchorState={anchorState} />
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

  it('renders attempt outcomes separately from the workflow conclusion', () => {
    renderCard(
      makeWork({
        attempts: [
          makeAttempt({
            status: 'completed',
            conclusion: 'failure',
            outcome: 'startup-failure',
          }),
        ],
      }),
    );

    const attempt = screen.getByTestId('logical-work-attempt-1');
    expect(within(attempt).getByText('failed')).toBeTruthy();
    expect(within(attempt).getByText('startup failure')).toBeTruthy();
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
    renderCard(makeWork({ provenance: { kind: 'legacy' } }));
    expect(screen.getByText(/no authoritative lifecycle state/)).toBeTruthy();
  });

  it('renders a friendly empty state when a task has zero attempts', () => {
    renderCard(makeWork({ attempts: [], state: 'pending' }));
    expect(
      screen.getByText('No workflow runs attributed to this task yet.'),
    ).toBeTruthy();
  });

  it('renders the native runs section alongside a real, still-visible GitHub Actions attempt (#1015)', () => {
    // A seeded orchestrator run does not retroactively prove every visible
    // GitHub Actions attempt is that same run - see logical-work-card.tsx's
    // own comment on why the legacy list stays up whenever it has content.
    renderCard(makeWork(), 'open', [makeRun()]);
    expect(screen.getByTestId('runs-section')).toBeTruthy();
    expect(screen.getByTestId('logical-work-attempts')).toBeTruthy();
    expect(
      screen.getByTestId('logical-work-attempts').textContent,
    ).not.toContain('No workflow runs attributed');
  });

  it('renders only the runs section, no empty-attempts placeholder, when orchestrator history exists but no attempt does', () => {
    renderCard(makeWork({ attempts: [] }), 'open', [makeRun()]);
    expect(screen.getByTestId('runs-section')).toBeTruthy();
    expect(screen.queryByTestId('logical-work-attempts')).toBeNull();
  });

  it('falls back to the legacy attempts list when the orchestrator has no run history for this task', () => {
    renderCard(makeWork(), 'open', []);
    expect(screen.queryByTestId('runs-section')).toBeNull();
    expect(screen.getByTestId('logical-work-attempts')).toBeTruthy();
  });
});
