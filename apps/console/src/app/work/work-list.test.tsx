import type { ItemView } from '@agent-lcars/work/derive';
import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  admittedAt,
  admittedQueue,
  providerCeilingMeta,
  WorkList,
} from './work-list';

const item: ItemView = {
  id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
  state: 'parked',
  spec: {
    title: 'Add healthz',
    description: 'd',
    pipeline: 'claude',
    target: { repo: 'jlapenna/agent-lcars' },
  },
  origin: { principal: 'user:jlapenna', channel: 'api' },
  createdAt: '2026-08-26T10:00:00.000Z',
  updatedAt: '2026-08-26T10:05:00.000Z',
  runs: [],
  sessions: [],
};

function renderList(items: ItemView[]) {
  render(
    <MantineProvider>
      <WorkList items={items} />
    </MantineProvider>,
  );
}

// Below `sm`, WorkList renders a card list instead of the 6-column table
// (#1814); both branches render unconditionally in jsdom (which doesn't
// evaluate the visibleFrom/hiddenFrom CSS media queries that keep only one
// visible in a real browser - see session-table.test.tsx for the same
// pattern elsewhere in this repo), so any row content shared by both views
// appears twice and needs getAllBy* rather than getBy*.
describe('WorkList', () => {
  it('shows the actual fallback pipeline while retaining the requested provider', () => {
    renderList([
      {
        ...item,
        state: 'running',
        runs: [
          {
            runId: 'work:x/r2',
            state: 'running',
            pipeline: 'codex',
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            providerFallback: {
              allowedPipelines: ['codex'],
              attemptedPipelines: ['claude', 'codex'],
              originalRunId: 'work:x/r1',
              fromRunId: 'work:x/r1',
              trigger: {
                reason: 'provider-limit',
                failureRunId: 'work:x/r1',
                limitedPipeline: 'claude',
              },
            },
          },
        ],
      },
    ]);
    expect(
      screen.getAllByText(/codex \(fallback; requested claude\)/),
    ).toHaveLength(2);
  });
  it('splits admitted work from recent work, stopped items first', () => {
    renderList([
      { ...item, id: '01J5Z3K9QX8F0N2B4V6C8D1E3H', state: 'running' },
      { ...item, id: '01J5Z3K9QX8F0N2B4V6C8D1E3J', state: 'done' },
      item,
    ]);
    const queue = screen.getByTestId('work-admitted-queue');
    expect(within(queue).getByText('Admitted queue')).toBeInTheDocument();
    expect(
      within(queue).getAllByRole('link', { name: /Add healthz/ }),
    ).toHaveLength(1);
    const recent = within(screen.getByTestId('work-recent')).getAllByRole(
      'link',
      { name: /Add healthz/ },
    );
    expect(recent[0]).toHaveAttribute('href', `/work/${item.id}`);
    expect(screen.getAllByText('parked')[0]).toBeInTheDocument();
  });

  it('keeps the phone Recent work head when nothing has stopped', () => {
    renderList([
      { ...item, id: '01J5Z3K9QX8F0N2B4V6C8D1E3H', state: 'running' },
    ]);
    const cards = screen.getByTestId('work-cards');
    expect(within(cards).getByText('Recent work')).toBeInTheDocument();
    expect(within(cards).getByText('None.')).toBeInTheDocument();
  });

  it('orders the admitted queue by priority, FIFO within a priority', () => {
    const at = (minute: number) =>
      `2026-08-26T10:${String(minute).padStart(2, '0')}:00.000Z`;
    const running = (
      id: string,
      title: string,
      priority: 'urgent' | 'normal' | 'background',
      minute: number,
    ): ItemView => ({
      ...item,
      id,
      state: 'running',
      createdAt: at(minute),
      spec: { ...item.spec, title, priority },
    });
    const queue = admittedQueue([
      running('a', 'late normal', 'normal', 30),
      running('b', 'background', 'background', 1),
      running('c', 'early normal', 'normal', 10),
      running('d', 'urgent', 'urgent', 40),
    ]);
    expect(queue.map((entry) => entry.spec.title)).toEqual([
      'urgent',
      'early normal',
      'late normal',
      'background',
    ]);
    renderList(queue);
    expect(
      within(screen.getByTestId('work-admitted-queue'))
        .getAllByText(/^P[123]$/)
        .map((cell) => cell.textContent),
    ).toEqual(['P1', 'P2', 'P2', 'P3']);
  });

  it('queues re-admitted work by its current run, not its first creation', () => {
    const readmitted: ItemView = {
      ...item,
      id: 'old',
      state: 'running',
      createdAt: '2026-08-26T09:00:00.000Z',
      spec: { ...item.spec, title: 'old item, new run' },
      runs: [
        {
          runId: 'work:old/r2',
          state: 'running',
          pipeline: 'claude',
          createdAt: '2026-08-26T11:00:00.000Z',
          updatedAt: '2026-08-26T11:00:00.000Z',
        },
      ],
    };
    const waiting: ItemView = {
      ...item,
      id: 'new',
      state: 'running',
      createdAt: '2026-08-26T10:00:00.000Z',
      spec: { ...item.spec, title: 'queued earlier' },
    };
    expect(
      admittedQueue([readmitted, waiting]).map((entry) => entry.id),
    ).toEqual(['new', 'old']);
    expect(admittedAt(readmitted)).toBe('2026-08-26T11:00:00.000Z');
  });

  it('links a title to its item detail page in both the card and table views', () => {
    renderList([item]);
    const links = screen.getAllByRole('link', { name: 'Add healthz' });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute('href', `/work/${item.id}`);
    }
  });

  it('names a done report as the result it is', () => {
    renderList([
      {
        ...item,
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
      },
      { ...item, id: '01J5Z3K9QX8F0N2B4V6C8D1E3H', state: 'done' },
    ]);
    expect(screen.getAllByText('done · report').length).toBeGreaterThan(0);
    expect(screen.getAllByText('done').length).toBeGreaterThan(0);
  });

  it('shows an empty state', () => {
    renderList([]);
    expect(screen.getByText(/No work items yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('work-cards')).toBeNull();
  });
});

describe('providerCeilingMeta', () => {
  it('names providers that share a ceiling together', () => {
    expect(providerCeilingMeta()).toBe('codex & opencode ceiling 1');
    expect(
      providerCeilingMeta({ opencode: 1, codex: 2, claude: undefined }),
    ).toBe('codex ceiling 2 · opencode ceiling 1');
    expect(providerCeilingMeta({})).toBeUndefined();
  });
});
