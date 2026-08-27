import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RunsTable } from './page';

// `page.tsx` also imports `../actions`, a `'use server'` module built on
// `@orpc/next`'s `createServerFunctionable` -- that package's own compiled
// output does an extensionless `next/navigation` import that only resolves
// under Next.js's bundler, not plain Node ESM (which is what Vitest uses
// for externalized node_modules). `RunsTable` never calls the actions, so
// stub the module rather than pull that broken import chain into a unit
// test that only renders a table.
vi.mock('../actions', () => ({
  getItem: vi.fn(),
  cancelItem: vi.fn(),
  redispatchItem: vi.fn(),
}));

function renderRuns(runs: Parameters<typeof RunsTable>[0]['runs']) {
  render(
    <MantineProvider>
      <RunsTable runs={runs} />
    </MantineProvider>,
  );
}

describe('RunsTable', () => {
  it('shows the executor and claimed-by line for a queue-executor run', () => {
    renderRuns([
      {
        runId: 'work:x/r1',
        state: 'running',
        pipeline: 'claude',
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z',
        executor: 'queue',
        queue: { state: 'claimed', claimedBy: 'runner-pike-1' },
      },
    ]);
    expect(screen.getByText('queue')).toBeInTheDocument();
    expect(screen.getByText(/claimed by runner-pike-1/u)).toBeInTheDocument();
  });

  it('shows github-actions for a run with no executor field', () => {
    renderRuns([
      {
        runId: 'gh:x/r1',
        state: 'running',
        pipeline: 'claude',
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z',
      },
    ]);
    expect(screen.getByText('github-actions')).toBeInTheDocument();
  });
});
