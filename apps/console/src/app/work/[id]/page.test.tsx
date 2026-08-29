import type { ItemView } from '@agent-lcars/work/derive';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RunsTable, SessionsList, WorkDetailViewContent } from './page';

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

// WorkDetailViewContent renders WorkActions, which calls useRouter --
// same mock work-actions.test.tsx itself uses.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

function renderRuns(runs: Parameters<typeof RunsTable>[0]['runs']) {
  render(
    <MantineProvider>
      <RunsTable runs={runs} />
    </MantineProvider>,
  );
}

describe('RunsTable', () => {
  it('shows the QueueExecutor and claimed-by line for a claimed run', () => {
    renderRuns([
      {
        runId: 'work:x/r1',
        state: 'running',
        pipeline: 'claude',
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z',
        queue: { state: 'claimed', claimedBy: 'runner-pike-1' },
      },
    ]);
    expect(screen.getByText('Queue executor')).toBeInTheDocument();
    expect(screen.getByText(/claimed by runner-pike-1/u)).toBeInTheDocument();
  });

  it('shows QueueExecutor for every run', () => {
    renderRuns([
      {
        runId: 'gh:x/r1',
        state: 'running',
        pipeline: 'claude',
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z',
      },
    ]);
    expect(screen.getByText('Queue executor')).toBeInTheDocument();
  });
});

const session: Parameters<typeof SessionsList>[0]['sessions'][number] = {
  sessionId: 'sess_1',
  runId: 'work:x/r1',
  startedAt: '2026-08-27T00:00:00.000Z',
  lastActivityAt: '2026-08-27T00:05:00.000Z',
};

function renderSessions(pinned: boolean) {
  render(
    <MantineProvider>
      <SessionsList sessions={[session]} pinned={pinned} />
    </MantineProvider>,
  );
}

describe('SessionsList', () => {
  it('shows a pinned badge for a session of an open item', () => {
    renderSessions(true);
    expect(screen.getByText('pinned')).toBeInTheDocument();
  });

  it('shows no pinned badge for a session of a settled item', () => {
    renderSessions(false);
    expect(screen.queryByText('pinned')).not.toBeInTheDocument();
  });
});

// I2: `work-router.ts`'s resume validation rejects a non-claude-code
// session with BAD_REQUEST and a session with no `transcriptGcsUri` with
// CONFLICT -- since telemetry starts for every pipeline, a parked item
// with a disqualified session must not offer a resume the redispatch call
// would only reject.
const parkedItem: ItemView = {
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
  runs: [
    {
      runId: 'work:x/r1',
      state: 'finished',
      pipeline: 'claude',
      createdAt: '2026-08-26T10:00:00.000Z',
      updatedAt: '2026-08-26T10:05:00.000Z',
    },
  ],
  sessions: [
    {
      sessionId: 'sess_1',
      runId: 'work:x/r1',
      startedAt: '2026-08-26T10:00:00.000Z',
      lastActivityAt: '2026-08-26T10:05:00.000Z',
      transcriptGcsUri: 'gs://bucket/sess_1.jsonl',
    },
  ],
};

function renderDetail(item: ItemView) {
  render(
    <MantineProvider>
      <WorkDetailViewContent
        detail={{ status: 'ok', item }}
        title="x"
        subtitle="y"
      />
    </MantineProvider>,
  );
}

describe('WorkDetailViewContent resume gate', () => {
  it('offers no resume for a codex item with sessions', () => {
    renderDetail({
      ...parkedItem,
      spec: { ...parkedItem.spec, pipeline: 'codex' },
      runs: parkedItem.runs.map((run) => ({ ...run, pipeline: 'codex' })),
    });
    expect(screen.queryByText(/Resume from session/i)).not.toBeInTheDocument();
  });

  it('offers no resume for a claude item whose session lacks transcriptGcsUri', () => {
    renderDetail({
      ...parkedItem,
      sessions: parkedItem.sessions.map((session) => ({
        ...session,
        transcriptGcsUri: undefined,
      })),
    });
    expect(screen.queryByText(/Resume from session/i)).not.toBeInTheDocument();
  });
});
