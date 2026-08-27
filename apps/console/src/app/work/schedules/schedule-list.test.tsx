import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ScheduleList, type ScheduleView } from './schedule-list';

// ScheduleActions ('use client') needs an app router context - mocked the
// same way work-actions.test.tsx does, since no <AppRouterContext.Provider>
// is mounted in this render.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

function schedule(over: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: '01M107KR3X6VDH7NZ4JDXZNSS2',
    cron: '0 * * * *',
    spec: {
      title: 'Hourly sync',
      description: 'd',
      pipeline: 'claude',
      target: { repo: 'jlapenna/agent-lcars' },
    },
    enabled: true,
    ...over,
  };
}

function renderList(schedules: ScheduleView[]) {
  render(
    <MantineProvider>
      <ScheduleList schedules={schedules} enable={vi.fn()} disable={vi.fn()} />
    </MantineProvider>,
  );
}

describe('ScheduleList', () => {
  it('shows an empty state with no schedules', () => {
    renderList([]);
    expect(screen.getByText('No schedules yet.')).toBeInTheDocument();
  });

  it('renders title, cron, pipeline, repo, enabled state, and a last-item link', () => {
    renderList([schedule({ lastItemId: '01M107KR3X6VDH7NZ4JDXZNSS3' })]);
    expect(screen.getByText('Hourly sync')).toBeInTheDocument();
    expect(screen.getByText('0 * * * *')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: '01M107KR3X6VDH7NZ4JDXZNSS3' }),
    ).toHaveAttribute('href', '/work/01M107KR3X6VDH7NZ4JDXZNSS3');
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
  });

  it('offers Enable for a disabled schedule', () => {
    renderList([schedule({ enabled: false })]);
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
  });
});
