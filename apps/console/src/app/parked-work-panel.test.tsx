import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ParkedWorkPanel } from './parked-work-panel';

// WorkActions ('use client') calls useRouter() unconditionally - same
// app-router-context workaround as work-actions.test.tsx.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

function item(
  overrides: Partial<{
    id: string;
    githubIssue: number | undefined;
    state: string;
    title: string;
    updatedAt: string;
    summary: string;
    /** The latest run's own state - distinct from the item's `state`
     *  above. Defaults to 'finished'; the #12 fixture below overrides it to
     *  'lost' with no `result` to exercise the row's `?? 'lost'` fallback. */
    latestRunState: string;
    /** Whether the latest run carries a `result` at all - a run can be
     *  'lost' before ever producing one. */
    hasResult: boolean;
  }>,
) {
  const {
    id = '01M107KR3X6VDH7NZ4JDXZNSS2',
    githubIssue,
    state = 'parked',
    title = 'T',
    updatedAt = '2026-08-27T04:30:00.000Z',
    summary = 'outcome-gate-failure',
    latestRunState = 'finished',
    hasResult = true,
  } = overrides;
  return {
    id:
      githubIssue === undefined ? `work:${id}` : `octo/example#${githubIssue}`,
    anchor:
      githubIssue === undefined
        ? { workId: id }
        : { repo: 'octo/example', issue: githubIssue },
    state,
    spec: {
      title,
      description: 'd',
      pipeline: 'claude',
      target: { repo: 'jlapenna/agent-lcars' },
    },
    origin: { principal: 'user:jlapenna', channel: 'console' },
    createdAt: updatedAt,
    updatedAt,
    runs: [
      {
        runId: `work:${id}/r1`,
        state: latestRunState,
        pipeline: 'claude',
        createdAt: updatedAt,
        updatedAt,
        ...(hasResult ? { result: { ok: false, summary } } : {}),
      },
    ],
    sessions: [],
  };
}

function renderPanel(
  items: unknown[],
  cancel = vi.fn(async () => [null, undefined] as const),
  redispatch = vi.fn(async () => [null, undefined] as const),
) {
  render(
    <MantineProvider>
      <ParkedWorkPanel
        items={items as never}
        cancel={cancel}
        redispatch={redispatch}
      />
    </MantineProvider>,
  );
  return { cancel, redispatch };
}

describe('ParkedWorkPanel', () => {
  it('renders nothing when no item is parked', () => {
    // Not toBeEmptyDOMElement(): MantineProvider itself injects <style>
    // tags into the render container regardless of children, so "renders
    // nothing" is checked against the panel's own root instead.
    renderPanel([item({ state: 'running' })]);
    expect(screen.queryByTestId('parked-work-panel')).toBeNull();
  });

  it('lists parked items oldest first with a link, the outcome, and actions', async () => {
    const { cancel, redispatch } = renderPanel([
      item({
        id: '01M107KR3X6VDH7NZ4JDXZNSS3',
        title: 'newer',
        updatedAt: '2026-08-27T05:00:00.000Z',
      }),
      item({
        id: '01M107KR3X6VDH7NZ4JDXZNSS2',
        title: 'older',
        updatedAt: '2026-08-27T04:00:00.000Z',
      }),
      item({ id: '01M107KR3X6VDH7NZ4JDXZNSS4', state: 'done' }),
    ]);
    const links = screen.getAllByRole('link', { name: /older|newer/ });
    expect(links.map((l) => l.textContent)).toEqual(['older', 'newer']);
    expect(links[0]).toHaveAttribute(
      'href',
      '/work/01M107KR3X6VDH7NZ4JDXZNSS2',
    );
    expect(screen.getAllByText('outcome-gate-failure')).toHaveLength(2);
    const redispatchButtons = screen.getAllByRole('button', {
      name: /redispatch/i,
    });
    expect(redispatchButtons).toHaveLength(2);
    expect(
      screen.getByRole('heading', { name: /Parked work \(2\)/ }),
    ).toBeInTheDocument();

    // Rows render oldest-first (asserted above), so the first Redispatch
    // button belongs to the older row.
    fireEvent.click(redispatchButtons[0]);
    await waitFor(() =>
      expect(redispatch).toHaveBeenCalledWith({
        id: '01M107KR3X6VDH7NZ4JDXZNSS2',
      }),
    );
    expect(cancel).not.toHaveBeenCalled();
  });

  it('shows "lost" when the latest run is lost with no result (#12)', () => {
    renderPanel([item({ latestRunState: 'lost', hasResult: false })]);
    expect(screen.getByText('lost')).toBeInTheDocument();
  });

  it('links a parked GitHub task to its canonical task page without native controls', () => {
    renderPanel([item({ githubIssue: 1502, title: 'GitHub task' })]);
    expect(screen.getByRole('link', { name: 'GitHub task' })).toHaveAttribute(
      'href',
      '/task/octo/example/1502',
    );
    expect(screen.queryByRole('button', { name: /redispatch/i })).toBeNull();
  });
});
