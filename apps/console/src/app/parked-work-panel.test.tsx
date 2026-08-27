import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
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
    state: string;
    title: string;
    updatedAt: string;
    summary: string;
  }>,
) {
  const {
    id = '01M107KR3X6VDH7NZ4JDXZNSS2',
    state = 'parked',
    title = 'T',
    updatedAt = '2026-08-27T04:30:00.000Z',
    summary = 'outcome-gate-failure',
  } = overrides;
  return {
    id,
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
        state: 'finished',
        pipeline: 'claude',
        createdAt: updatedAt,
        updatedAt,
        result: { ok: false, summary },
      },
    ],
    sessions: [],
  };
}

function renderPanel(items: unknown[]) {
  return render(
    <MantineProvider>
      <ParkedWorkPanel
        items={items as never}
        cancel={vi.fn()}
        redispatch={vi.fn()}
      />
    </MantineProvider>,
  );
}

describe('ParkedWorkPanel', () => {
  it('renders nothing when no item is parked', () => {
    // Not toBeEmptyDOMElement(): MantineProvider itself injects <style>
    // tags into the render container regardless of children, so "renders
    // nothing" is checked against the panel's own root instead.
    renderPanel([item({ state: 'running' })]);
    expect(screen.queryByTestId('parked-work-panel')).toBeNull();
  });

  it('lists parked items oldest first with a link, the outcome, and actions', () => {
    renderPanel([
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
    expect(screen.getAllByRole('button', { name: /redispatch/i })).toHaveLength(
      2,
    );
    expect(
      screen.getByRole('heading', { name: /Parked work \(2\)/ }),
    ).toBeInTheDocument();
  });
});
