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
  RUN_TIMEOUT_MINUTES: 120,
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
  it.each(['missing-generation', 'octo/example#42/r9007199254740993'])(
    'omits an unknown generation badge for %s while retaining the run',
    (runId) => {
      renderRuns([makeRun({ runId })]);
      const row = screen.getByTestId(`run-${runId}`);
      expect(within(row).getByTestId('run-state').textContent).toBe('running');
      expect(within(row).queryByText(/^g\d+$/)).toBeNull();
    },
  );

  it('renders the generation of a native Work run', () => {
    const runId = 'work:01J5Z3K9QX8F0N2B4V6C8D1E4H/r12';
    renderRuns([
      makeRun({ runId, task: { workId: '01J5Z3K9QX8F0N2B4V6C8D1E4H' } }),
    ]);
    expect(
      within(screen.getByTestId(`run-${runId}`)).getByText('g12'),
    ).toBeTruthy();
  });

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

  it('renders the observed queued run lease as a future deadline', () => {
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-10-10T07:44:39.955Z').getTime());
    try {
      const run = makeRun({
        runId: 'jlapenna/agent-lcars#2379/r1',
        task: { repo: 'jlapenna/agent-lcars', issue: 2379 },
        pipeline: 'codex',
        leaseExpiresAt: '2026-10-10T09:32:27.791Z',
        createdAt: '2026-10-10T07:32:27.294Z',
        updatedAt: '2026-10-10T07:32:27.791Z',
        queue: { state: 'queued' },
      });
      renderRuns([run]);
      const row = screen.getByTestId(`run-${run.runId}`);
      expect(within(row).getByText(/lease expires/)).toHaveTextContent(
        'lease expires in 1 hour',
      );
      expect(within(row).getByText('in 1 hour')).toHaveAttribute(
        'datetime',
        run.leaseExpiresAt,
      );
    } finally {
      now.mockRestore();
    }
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

it.each([
  ['comment', 'https://github.com/octo/example/issues/42#issuecomment-99'],
  ['review', 'https://github.com/octo/example/pull/42#pullrequestreview-100'],
  ['no-op', 'https://github.com/octo/example/issues/42#issuecomment-99'],
  ['park', 'https://github.com/octo/example/issues/42#issuecomment-99'],
])('renders the exact %s result permalink', (summary, ref) => {
  renderRuns([
    makeRun({ state: 'finished', result: { ok: true, summary, ref } }),
  ]);
  expect(screen.getByRole('link', { name: ref })).toHaveAttribute('href', ref);
});
it('renders both partial PR and blocker links while guarding every related value', () => {
  const ref = 'https://github.com/octo/example/pull/12';
  const blocker = 'https://github.com/octo/example/issues/42#issuecomment-99';
  renderRuns([
    makeRun({
      state: 'finished',
      result: { ok: true, summary: 'park', ref, relatedRefs: [blocker] },
    }),
  ]);
  expect(screen.getByRole('link', { name: ref })).toHaveAttribute('href', ref);
  expect(screen.getByRole('link', { name: blocker })).toHaveAttribute(
    'href',
    blocker,
  );
});
it('keeps a dangerous related reference inert', () => {
  renderRuns([
    makeRun({
      state: 'finished',
      result: {
        ok: true,
        summary: 'park',
        relatedRefs: ['javascript:alert(1)'],
      },
    }),
  ]);
  expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument();
  expect(
    screen.queryByRole('link', { name: 'javascript:alert(1)' }),
  ).toBeNull();
});

it('keeps exact result links and fallback provenance together on the fresh attempt', () => {
  const originalRunId = 'supersprinklesracing/sprinkles#42/r1';
  const runId = 'supersprinklesracing/sprinkles#42/r2';
  const ref = 'https://github.com/supersprinklesracing/sprinkles/pull/77';
  const blocker =
    'https://github.com/supersprinklesracing/sprinkles/issues/42#issuecomment-99';
  renderRuns([
    makeRun({
      runId,
      pipeline: 'codex',
      state: 'finished',
      providerFallback: {
        allowedPipelines: ['codex', 'opencode'],
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
        ref,
        relatedRefs: [blocker, ref, 'javascript:alert(1)'],
      },
    }),
  ]);
  const row = within(screen.getByTestId(`run-${runId}`));
  expect(
    row.getByText(/Fresh attempt on codex.*claude reported a provider limit/),
  ).toBeInTheDocument();
  expect(
    row.getByText(
      /Original intent:.*\/r1; previous attempt:.*\/r1; triggering failure:.*\/r1/,
    ),
  ).toBeInTheDocument();
  expect(row.getAllByRole('link', { name: ref })).toHaveLength(1);
  expect(row.getByRole('link', { name: blocker })).toHaveAttribute(
    'href',
    blocker,
  );
  expect(row.queryByRole('link', { name: 'javascript:alert(1)' })).toBeNull();
});
