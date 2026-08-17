import type { Run as OrchestratorRun } from '@agent-lcars/orchestrator';
import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RunsSection } from './runs-section';

// Mirrors logical-work-card.test.tsx's own mock of this module: it pulls in
// the server-only GitHub client at import time (assertNotBrowser()), which
// fails immediately under jsdom - see that file's identical comment. Only
// the bindings `agent-activity-panel.tsx`'s `PipelineBadge` transitively
// needs at *import* time have to resolve; nothing here calls the mocked
// functions themselves.
vi.mock('../../lib/agent-activity', () => ({
  RUN_TIMEOUT_MINUTES: 90,
  issueUrlForRun: () => undefined,
}));

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

function renderRuns(runs: OrchestratorRun[]) {
  render(
    <MantineProvider>
      <RunsSection runs={runs} />
    </MantineProvider>,
  );
}

describe('RunsSection', () => {
  it('renders a lost run along with the expiry event note explaining the retry', () => {
    const run = makeRun({
      runId: 'supersprinklesracing/sprinkles#42/r2',
      state: 'lost',
      events: [
        { at: '2026-07-07T00:00:00Z', to: 'pending', by: 'request' },
        { at: '2026-07-07T00:05:00Z', to: 'running', by: 'dispatch' },
        {
          at: '2026-07-07T02:05:00Z',
          to: 'lost',
          by: 'expiry',
          note: 'lease expired with no report; auto-retry 1/3',
        },
      ],
    });
    renderRuns([run]);

    const row = screen.getByTestId(`run-${run.runId}`);
    expect(within(row).getByTestId('run-state').textContent).toBe('lost');
    expect(
      within(row).getByText('lease expired with no report; auto-retry 1/3'),
    ).toBeTruthy();
  });

  it('renders a finished ok run with its result summary and PR ref as a link', () => {
    const run = makeRun({
      state: 'finished',
      result: {
        ok: true,
        summary: 'Implemented the feature and opened a PR.',
        ref: 'https://github.com/supersprinklesracing/sprinkles/pull/77',
      },
    });
    renderRuns([run]);

    const row = screen.getByTestId(`run-${run.runId}`);
    expect(within(row).getByText('finished')).toBeTruthy();
    expect(
      within(row).getByText('Implemented the feature and opened a PR.'),
    ).toBeTruthy();
    const link = within(row).getByText(
      'https://github.com/supersprinklesracing/sprinkles/pull/77',
    );
    expect(link.closest('a')?.getAttribute('href')).toBe(
      'https://github.com/supersprinklesracing/sprinkles/pull/77',
    );
  });

  it('distinguishes a finished-but-unsuccessful run as failed, not just "finished"', () => {
    const run = makeRun({
      state: 'finished',
      result: { ok: false, summary: 'Startup failed.' },
    });
    renderRuns([run]);

    const row = screen.getByTestId(`run-${run.runId}`);
    expect(within(row).getByText('failed')).toBeTruthy();
    expect(within(row).queryByText('finished')).toBeNull();
  });

  it('renders a live pending run with its lease expiry, and params as chips', () => {
    const run = makeRun({
      state: 'pending',
      params: { mode: 'implement', runbook: 'fix-flaky' },
    });
    renderRuns([run]);

    const row = screen.getByTestId(`run-${run.runId}`);
    expect(within(row).getByTestId('run-state').textContent).toBe('pending');
    expect(within(row).getByText(/lease expires/)).toBeTruthy();
    expect(within(row).getByText('mode: implement')).toBeTruthy();
    expect(within(row).getByText('runbook: fix-flaky')).toBeTruthy();
  });

  it('omits the lease expiry for a terminal run', () => {
    const run = makeRun({ state: 'canceled' });
    renderRuns([run]);

    const row = screen.getByTestId(`run-${run.runId}`);
    expect(within(row).queryByText(/lease expires/)).toBeNull();
  });

  it('renders every run, newest first, never collapsing history', () => {
    renderRuns([
      makeRun({
        runId: 'supersprinklesracing/sprinkles#42/r1',
        createdAt: '2026-07-07T00:00:00Z',
      }),
      makeRun({
        runId: 'supersprinklesracing/sprinkles#42/r2',
        createdAt: '2026-07-08T00:00:00Z',
      }),
    ]);

    const section = screen.getByTestId('runs-section');
    expect(section.textContent).toContain('Runs (2)');
    const rows = within(section).getAllByText(/^g\d$/);
    expect(rows.map((el) => el.textContent)).toEqual(['g2', 'g1']);
  });
});
