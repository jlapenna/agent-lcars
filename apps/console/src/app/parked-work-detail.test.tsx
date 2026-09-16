import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ParkedWorkDetail } from './parked-work-detail';

// WorkActions ('use client') calls useRouter() unconditionally - same
// app-router-context workaround as work-actions.test.tsx.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

function nativeItem() {
  return {
    id: 'work:01M107KR3X6VDH7NZ4JDXZNSS2',
    anchor: { workId: '01M107KR3X6VDH7NZ4JDXZNSS2' },
    state: 'parked',
    spec: {
      title: 'T',
      description: 'd',
      pipeline: 'claude',
      target: { repo: 'jlapenna/agent-lcars' },
    },
    origin: { principal: 'user:jlapenna', channel: 'console' },
    createdAt: '2026-08-27T04:00:00.000Z',
    updatedAt: '2026-08-27T04:30:00.000Z',
    runs: [
      {
        runId: 'work:01M107KR3X6VDH7NZ4JDXZNSS2/r1',
        state: 'finished',
        pipeline: 'claude',
        createdAt: '2026-08-27T04:00:00.000Z',
        updatedAt: '2026-08-27T04:30:00.000Z',
        result: { ok: false, summary: 'outcome-gate-failure' },
      },
    ],
  };
}

function githubItem() {
  return {
    ...nativeItem(),
    id: 'octo/example#1502',
    anchor: { repo: 'octo/example', issue: 1502 },
  };
}

describe('ParkedWorkDetail', () => {
  it('offers native redispatch/cancel controls and every run outcome', () => {
    const cancel = vi.fn(async () => [null, undefined] as const);
    const redispatch = vi.fn(async () => [null, undefined] as const);
    render(
      <MantineProvider>
        <ParkedWorkDetail
          item={nativeItem() as never}
          cancel={cancel}
          redispatch={redispatch}
        />
      </MantineProvider>,
    );
    expect(
      screen.getByRole('button', { name: /redispatch/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByText(/outcome-gate-failure/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /view full history/i }),
    ).toHaveAttribute('href', '/work/01M107KR3X6VDH7NZ4JDXZNSS2');
  });

  it('falls back to the GitHub redispatch link for a GitHub-anchored item', () => {
    const noop = vi.fn(async () => [null, undefined] as const);
    render(
      <MantineProvider>
        <ParkedWorkDetail
          item={githubItem() as never}
          cancel={noop}
          redispatch={noop}
        />
      </MantineProvider>,
    );
    expect(screen.queryByRole('button', { name: /redispatch/i })).toBeNull();
    expect(
      screen.getByRole('link', { name: /redispatch on github/i }),
    ).toHaveAttribute('href', 'https://github.com/octo/example/issues/1502');
    expect(
      screen.getByRole('link', { name: /view full history/i }),
    ).toHaveAttribute('href', '/task/octo/example/1502');
  });
});
