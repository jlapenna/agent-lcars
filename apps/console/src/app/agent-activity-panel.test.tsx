import type {
  IssueAgentSessionDoc,
  SessionSource,
} from '@agent-lcars/telemetry';
import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentActivity, AgentRun } from '../lib/agent-activity';
import type { CliSession } from '../lib/cli-sessions';
import {
  AgentActivityPanel,
  type RunItemRef,
  SourceBadge,
} from './agent-activity-panel';

// CancelRunButton is a 'use server' client component wired to backend
// actions - out of scope here, matching the pattern in
// action-items-board.test.tsx.
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('./cancel-run-button', () => ({
  CancelRunButton: () => null,
}));

// agent-activity.ts pulls in the server-only (ESM) GitHub client - stub the
// runtime values this panel actually uses so the module never loads (and
// its assertNotBrowser() guard never fires) at test time. Every other
// import from it is type-only. The pure helpers are reimplemented here
// rather than imported for real - agent-activity.test.ts is the source of
// truth for their actual behavior; keep these in sync with it.
// QUEUE_STALL_THRESHOLD_SECONDS itself is pulled from the real module
// (importActual is safe here - it never touches the browser guard, see the
// note above) so findStalledQueuedRun's reimplemented threshold can't
// silently drift from production (#863).
vi.mock('../lib/agent-activity', async () => {
  const { QUEUE_STALL_THRESHOLD_SECONDS } = await vi.importActual<
    typeof import('../lib/agent-activity')
  >('../lib/agent-activity');
  return {
    RECENT_RUN_LIMIT: 8,
    RUN_TIMEOUT_MINUTES: 90,
    MAX_TURNS_BUDGET: 200,
    QUEUE_STALL_THRESHOLD_SECONDS,
    displayRunTitle: (run: AgentRun) =>
      run.pipeline === 'opencode'
        ? run.displayTitle.replace(/^opencode\s+/, '')
        : run.displayTitle,
    findStalledQueuedRun: (liveRuns: AgentRun[]) =>
      liveRuns
        .filter(
          (run) =>
            run.status === 'queued' &&
            run.elapsedSeconds > QUEUE_STALL_THRESHOLD_SECONDS,
        )
        .sort((a, b) => b.elapsedSeconds - a.elapsedSeconds)[0],
    issueUrlForRun: (run: AgentRun) =>
      run.issueNumber === undefined
        ? undefined
        : `https://github.com/supersprinklesracing/sprinkles/issues/${run.issueNumber}`,
    groupLiveRunsByIssue: (liveRuns: AgentRun[]) => {
      const groups = new Map<
        string,
        { key: string; issueNumber?: number; runs: AgentRun[] }
      >();
      for (const run of liveRuns) {
        const key =
          run.issueNumber === undefined
            ? `run-${run.id}`
            : `${run.repo.owner}/${run.repo.name}#${run.issueNumber}`;
        const existing = groups.get(key);
        if (existing) {
          existing.runs.push(run);
        } else {
          groups.set(key, { key, issueNumber: run.issueNumber, runs: [run] });
        }
      }
      return Array.from(groups.values());
    },
    duplicateLivePipelineGroups: (runs: AgentRun[]) => {
      const live = runs.filter(
        (run) => run.status === 'queued' || run.status === 'running',
      );
      const byPipeline = new Map<string, AgentRun[]>();
      for (const run of live) {
        const group = byPipeline.get(run.pipeline);
        if (group) group.push(run);
        else byPipeline.set(run.pipeline, [run]);
      }
      for (const [pipeline, group] of byPipeline) {
        if (group.length <= 1) byPipeline.delete(pipeline);
      }
      return byPipeline;
    },
  };
});

// react-markdown/remark-gfm (pulled in via artifact-viewer.tsx) are ESM-only
// (unified ecosystem) - see artifact-viewer.test.tsx for the same stub.
vi.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <>{children}</>,
}));
vi.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));

const EMPTY_ACTIVITY: AgentActivity = {
  liveRuns: [],
  recentRuns: [],
  fleet: { online: 0, busy: 0 },
  warnings: [],
};

function makeCliSession(overrides: Partial<CliSession> = {}): CliSession {
  return {
    sessionId: 'session-1',
    liveness: 'live',
    agent: 'claude-code',
    host: 'joes-workstation',
    branch: 'feat/agent-lcars-cli-sessions',
    turns: 4,
    totalTokens: 1200,
    startedAt: '2026-07-12T00:00:00.000Z',
    lastActivityAt: '2026-07-12T00:05:00.000Z',
    ...overrides,
  };
}

function renderPanel(
  cliSessions: CliSession[],
  activity: AgentActivity = EMPTY_ACTIVITY,
  sessionsByRunId?: Record<number, IssueAgentSessionDoc>,
  itemsByRunId?: Record<number, RunItemRef>,
  repoFilter?: string,
) {
  render(
    <MantineProvider>
      <AgentActivityPanel
        activity={activity}
        cliSessions={cliSessions}
        sessionsByRunId={sessionsByRunId}
        itemsByRunId={itemsByRunId}
        repoFilter={repoFilter}
      />
    </MantineProvider>,
  );
}

function makeAgentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 1,
    repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
    pipeline: 'claude',
    status: 'completed',
    conclusion: 'success',
    event: 'workflow_dispatch',
    url: 'https://github.com/o/r/actions/runs/1',
    displayTitle: '#123: Fix status tags on mobile',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:05:00.000Z',
    elapsedSeconds: 300,
    ...overrides,
  };
}

function makeIssueAgentSessionDoc(
  overrides: Partial<IssueAgentSessionDoc> = {},
): IssueAgentSessionDoc {
  return {
    sessionId: 'session-runner-1',
    source: 'issue-agent',
    liveness: 'ended',
    startedAt: '2026-07-12T00:00:00.000Z',
    lastActivityAt: '2026-07-12T00:05:00.000Z',
    turns: 5,
    toolCallCounts: {},
    tokens: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [42], commitShas: [] },
    runId: '1',
    ...overrides,
  };
}

describe('AgentActivityPanel CLI sessions', () => {
  it('renders nothing extra when there are no CLI sessions', () => {
    renderPanel([]);
    expect(screen.queryByText('CLI sessions')).toBeNull();
    expect(screen.getByText('No work is currently in flight.')).toBeTruthy();
  });

  it('renders an active CLI session without host or worktree metadata', () => {
    renderPanel([
      makeCliSession({
        title: 'Merge live CLI sessions into the list',
        model: 'claude-sonnet-5',
      }),
    ]);

    expect(screen.getByText('CLI sessions')).toBeTruthy();
    expect(screen.getByText('live')).toBeTruthy();
    expect(
      screen.getByText('Merge live CLI sessions into the list'),
    ).toBeTruthy();
    expect(screen.queryByText('joes-workstation')).toBeNull();
    expect(screen.queryByText(/feat\/agent-lcars-cli-sessions/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Open session' })).toBeTruthy();
  });

  it('omits the model, turn count, and token count texts (#3012)', () => {
    renderPanel([
      makeCliSession({ model: 'claude-sonnet-5', turns: 4, totalTokens: 1200 }),
    ]);

    expect(screen.queryByText('claude-sonnet-5')).toBeNull();
    expect(screen.queryByText('4 turns')).toBeNull();
    expect(screen.queryByText('1.2k tokens')).toBeNull();
  });

  it('keeps PR metadata off the Bridge row when one exists', () => {
    renderPanel([
      makeCliSession({
        pr: {
          number: 2587,
          url: 'https://github.com/o/r/pull/2587',
        },
      }),
    ]);

    expect(screen.queryByRole('link', { name: /PR #2587/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open session' })).toBeTruthy();
  });

  it('always links to the session detail page', () => {
    renderPanel([makeCliSession({ sessionId: 'abc-123' })]);

    const link = screen.getByTestId('cli-session-link');
    expect(link.getAttribute('href')).toBe('/sessions/abc-123');
  });

  it('does not expose an opaque session UUID as a Bridge label', () => {
    renderPanel([
      makeCliSession({
        sessionId: '34e381cd-aaaa-bbbb-cccc-123456789abc',
        title: undefined,
        branch: undefined,
        host: 'pike',
      }),
    ]);

    expect(screen.getByText('Session on pike')).toBeTruthy();
    expect(
      screen.queryByText('34e381cd-aaaa-bbbb-cccc-123456789abc'),
    ).toBeNull();
  });

  it('keeps artifact metadata on the session detail route', () => {
    renderPanel([
      makeCliSession({
        sessionId: 'abc-123',
        host: 'pike',
        artifacts: ['report.md', 'chart.png'],
      }),
    ]);

    expect(screen.queryByRole('link', { name: /report\.md/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /chart\.png/ })).toBeNull();
    expect(screen.getByTestId('cli-session-link')).toHaveAttribute(
      'href',
      '/sessions/abc-123',
    );
  });

  it('renders no artifacts section when the session has none', () => {
    renderPanel([makeCliSession({ artifacts: [] })]);
    expect(screen.queryByText('Artifacts:')).toBeNull();
  });

  it('protects the liveness tag from shrinking (and clipping) in its nowrap row', () => {
    renderPanel([
      makeCliSession({
        title: 'A very long session title that squeezes the row width',
      }),
    ]);

    expect(screen.getByTestId('cli-session-liveness').style.flexShrink).toBe(
      '0',
    );
  });

  it('shows live/idle sessions and leaves ended/stale history to Sessions', () => {
    renderPanel([
      makeCliSession({ sessionId: 's-live', liveness: 'live' }),
      makeCliSession({ sessionId: 's-idle', liveness: 'idle' }),
      makeCliSession({ sessionId: 's-ended', liveness: 'ended' }),
      makeCliSession({ sessionId: 's-stale', liveness: 'stale' }),
    ]);

    expect(screen.getByTestId('cli-session-s-live')).toBeTruthy();
    expect(screen.getByTestId('cli-session-s-idle')).toBeTruthy();
    expect(screen.queryByTestId('cli-session-s-ended')).toBeNull();
    expect(screen.queryByTestId('cli-session-s-stale')).toBeNull();
    expect(screen.queryByTestId('recent-sessions')).toBeNull();
  });

  // A Mantine Badge's label clips with `overflow: hidden`, which resets the
  // flex item's automatic minimum size to 0 - inside a `wrap="nowrap"`
  // Group, that lets nowrap siblings squeeze the badge down to no visible
  // text on narrow viewports unless it opts out with flexShrink: 0.
  it('keeps the CLI session liveness badge from shrinking away on narrow layouts', () => {
    renderPanel([makeCliSession({ liveness: 'live' })]);
    const badge = screen.getByTestId('cli-session-liveness');
    expect(badge.style.flexShrink).toBe('0');
  });

  it('renders no agent badge for a claude-code session (the overwhelming default)', () => {
    renderPanel([makeCliSession({ agent: 'claude-code' })]);
    expect(screen.queryByText('claude code')).toBeNull();
  });

  it('renders an agent badge for a non-claude-code session', () => {
    renderPanel([makeCliSession({ agent: 'opencode' })]);
    expect(screen.getByText('opencode')).toBeTruthy();
  });
});

describe('AgentActivityPanel recent runs', () => {
  it('keeps only five outcomes visible and links to the full Agents history', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      recentRuns: [1, 2, 3, 4, 5, 6].map((id) =>
        makeAgentRun({ id, displayTitle: `#${id}: Result ${id}` }),
      ),
    });

    expect(screen.getAllByTestId('finished-run-row')).toHaveLength(5);
    expect(
      screen.getByRole('link', { name: 'View all outcomes →' }),
    ).toHaveAttribute('href', '/agents');
  });

  it('keeps the active repository scope when opening all outcomes', () => {
    renderPanel(
      [],
      {
        ...EMPTY_ACTIVITY,
        recentRuns: [makeAgentRun()],
      },
      undefined,
      undefined,
      'supersprinklesracing/sprinkles',
    );

    expect(
      screen.getByRole('link', { name: 'View all outcomes →' }),
    ).toHaveAttribute('href', '/agents?repo=supersprinklesracing%2Fsprinkles');
  });

  it('keeps the recent-run conclusion badge from shrinking away on narrow layouts', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      recentRuns: [makeAgentRun()],
    });
    const badge = screen.getByTestId('recent-run-conclusion');
    expect(badge.style.flexShrink).toBe('0');
    expect(badge.textContent).toBe('success');
  });

  it('links a finished result action to the canonical task route', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      recentRuns: [makeAgentRun({ issueNumber: 42 })],
    });
    const link = screen.getByTestId('outcome-primary-action');
    expect(link.getAttribute('href')).toBe(
      '/task/supersprinklesracing/sprinkles/42',
    );
    expect(link.textContent).toBe('View result');
  });

  it('falls back to the run URL when a legacy run has no parsed issueNumber (#3012)', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      recentRuns: [makeAgentRun({ issueNumber: undefined })],
    });
    const link = screen.getByTestId('outcome-primary-action');
    expect(link.getAttribute('href')).toBe(
      'https://github.com/o/r/actions/runs/1',
    );
  });

  it('shows the latest outcomes by default with no disclosure', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      recentRuns: [makeAgentRun()],
    });
    expect(screen.getByTestId('latest-outcomes')).toBeTruthy();
    expect(screen.getByText('Latest Outcomes')).toBeTruthy();
    expect(screen.queryByTestId('recent-runs')).toBeNull();
  });

  it('shows a plain "cancelled" badge for a quick cancel, and "timeout" for a near-budget one', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      recentRuns: [
        makeAgentRun({
          id: 10,
          conclusion: 'cancelled',
          elapsedSeconds: 5,
        }),
      ],
    });
    expect(screen.getByTestId('recent-run-conclusion').textContent).toBe(
      'cancelled',
    );
    expect(screen.getByTestId('outcome-primary-action').textContent).toBe(
      'Investigate ↗',
    );
  });

  it('shows "timeout" instead of "cancelled" for a run killed near the wall-clock budget', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      recentRuns: [
        makeAgentRun({
          id: 11,
          conclusion: 'cancelled',
          elapsedSeconds: 90 * 60,
        }),
      ],
    });
    expect(screen.getByTestId('recent-run-conclusion').textContent).toBe(
      'timeout',
    );
  });

  it('shows a "silent error" badge and diagnosis when the joined session flags a known error signature despite a success conclusion', () => {
    renderPanel(
      [],
      {
        ...EMPTY_ACTIVITY,
        recentRuns: [makeAgentRun({ id: 12, conclusion: 'success' })],
      },
      {
        12: makeIssueAgentSessionDoc({
          result: { subtype: 'error_max_turns', isError: true },
        }),
      },
    );
    expect(screen.getByTestId('recent-run-conclusion').textContent).toBe(
      'silent error',
    );
    expect(screen.getByTestId('finished-run-diagnosis').textContent).toContain(
      'failure signature',
    );
  });

  it('shows a "silent error" badge when the joined session recorded zero turns despite a success conclusion', () => {
    renderPanel(
      [],
      {
        ...EMPTY_ACTIVITY,
        recentRuns: [makeAgentRun({ id: 15, conclusion: 'success' })],
      },
      {
        // Zero recorded turns despite a success conclusion is a
        // session-provable anomaly (see run-status-classifier.ts) - unlike
        // "no PR/commit", which claude.yml's own server-side gates already
        // rule out before a run can report success at all.
        15: makeIssueAgentSessionDoc({ turns: 0 }),
      },
    );
    expect(screen.getByTestId('recent-run-conclusion').textContent).toBe(
      'silent error',
    );
    expect(screen.getByTestId('finished-run-diagnosis').textContent).toContain(
      'zero turns',
    );
  });

  it('does not flag a success run whose session shows real turns but no PR/commit (e.g. a comment-only reply)', () => {
    renderPanel(
      [],
      {
        ...EMPTY_ACTIVITY,
        recentRuns: [makeAgentRun({ id: 14, conclusion: 'success' })],
      },
      {
        14: makeIssueAgentSessionDoc({
          turns: 3,
          deliverables: { prNumbers: [], commitShas: [] },
        }),
      },
    );
    expect(screen.getByTestId('recent-run-conclusion').textContent).toBe(
      'success',
    );
    expect(screen.queryByTestId('finished-run-diagnosis')).toBeNull();
  });

  it('renders no diagnosis line for an ordinary success with no joined session', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      recentRuns: [makeAgentRun({ id: 13, conclusion: 'success' })],
    });
    expect(screen.queryByTestId('finished-run-diagnosis')).toBeNull();
  });

  it('uses a joined session for classification without adding a session metadata link', () => {
    renderPanel(
      [],
      {
        ...EMPTY_ACTIVITY,
        recentRuns: [makeAgentRun({ id: 14 })],
      },
      { 14: makeIssueAgentSessionDoc({ sessionId: 'session-runner-14' }) },
    );
    expect(screen.getByTestId('recent-run-conclusion')).toBeTruthy();
    expect(screen.queryByTestId('finished-run-session-link')).toBeNull();
  });

  it('renders no session link when no session doc is joined', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      recentRuns: [makeAgentRun({ id: 15 })],
    });
    expect(screen.queryByTestId('finished-run-session-link')).toBeNull();
  });
});

describe('AgentActivityPanel live run links (#176)', () => {
  it('labels the running run wall-clock budget gauge', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      liveRuns: [makeAgentRun({ id: 29, status: 'running' })],
    });

    expect(
      screen.getByRole('progressbar', { name: 'Run wall-clock budget' }),
    ).toBeTruthy();
  });

  it('opens a joined live run on its canonical task route', () => {
    renderPanel(
      [],
      {
        ...EMPTY_ACTIVITY,
        liveRuns: [makeAgentRun({ id: 30, status: 'running' })],
      },
      undefined,
      {
        30: {
          number: 42,
          title: 'Fix the thing',
          url: 'https://github.com/o/r/issues/42',
        },
      },
    );
    const link = screen.getByTestId('current-run-primary-action');
    expect(link.getAttribute('href')).toBe(
      '/task/supersprinklesracing/sprinkles/42',
    );
    expect(link.textContent).toBe('Open task');
  });

  it('opens the canonical task when issueNumber parses without a joined item', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      liveRuns: [makeAgentRun({ id: 31, status: 'running', issueNumber: 99 })],
    });
    const link = screen.getByTestId('current-run-primary-action');
    expect(link.getAttribute('href')).toBe(
      '/task/supersprinklesracing/sprinkles/99',
    );
  });

  it('falls back to the raw run URL only when issueNumber cannot be parsed either', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      liveRuns: [
        makeAgentRun({ id: 32, status: 'running', issueNumber: undefined }),
      ],
    });
    const link = screen.getByTestId('current-run-primary-action');
    expect(link.getAttribute('href')).toBe(
      'https://github.com/o/r/actions/runs/1',
    );
  });

  it('does not add a session metadata link when telemetry is joined to a live run', () => {
    renderPanel(
      [],
      {
        ...EMPTY_ACTIVITY,
        liveRuns: [makeAgentRun({ id: 33, status: 'running' })],
      },
      { 33: makeIssueAgentSessionDoc({ sessionId: 'session-runner-33' }) },
    );
    expect(screen.getByTestId('current-run-primary-action')).toBeTruthy();
    expect(screen.queryByTestId('live-run-session-link')).toBeNull();
  });

  it('renders no session link on a live run when no session doc is joined', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      liveRuns: [makeAgentRun({ id: 34, status: 'running' })],
    });
    expect(screen.queryByTestId('live-run-session-link')).toBeNull();
  });
});

describe('AgentActivityPanel live run grouping by issue id (#239)', () => {
  it('renders no group wrapper for a single live run on its own issue', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      liveRuns: [makeAgentRun({ id: 50, status: 'running', issueNumber: 50 })],
    });
    expect(screen.queryByTestId('live-run-group-50')).toBeNull();
    expect(screen.getByTestId('current-run-row')).toBeTruthy();
  });

  it('clusters two live runs sharing the same issue number under one group', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      liveRuns: [
        makeAgentRun({
          id: 40,
          status: 'running',
          issueNumber: 42,
          pipeline: 'claude',
        }),
        makeAgentRun({
          id: 41,
          status: 'running',
          issueNumber: 42,
          pipeline: 'codex',
        }),
      ],
    });
    const group = screen.getByTestId('live-run-group-42');
    expect(within(group).getAllByTestId('current-run-row')).toHaveLength(2);
    expect(group.textContent).toContain('2 runs');
  });

  it('keeps runs on different issue numbers out of each others groups', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      liveRuns: [
        makeAgentRun({ id: 45, status: 'running', issueNumber: 45 }),
        makeAgentRun({ id: 46, status: 'running', issueNumber: 46 }),
      ],
    });
    expect(screen.queryByTestId('live-run-group-45')).toBeNull();
    expect(screen.queryByTestId('live-run-group-46')).toBeNull();
    expect(screen.getAllByTestId('current-run-row')).toHaveLength(2);
  });

  it('flags two same-pipeline live attempts on one issue as a duplicate, never dropping either (#306)', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      liveRuns: [
        makeAgentRun({
          id: 70,
          status: 'queued',
          issueNumber: 70,
          pipeline: 'claude',
        }),
        makeAgentRun({
          id: 71,
          status: 'running',
          issueNumber: 70,
          pipeline: 'claude',
        }),
      ],
    });
    const group = screen.getByTestId('live-run-group-70');
    expect(within(group).getAllByTestId('current-run-row')).toHaveLength(2);
    const duplicateAlert = screen.getByTestId('live-run-group-70-duplicate');
    expect(duplicateAlert.textContent).toContain('2 claude');
  });

  it('does not flag a cross-pipeline race on one issue as a duplicate', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      liveRuns: [
        makeAgentRun({
          id: 72,
          status: 'running',
          issueNumber: 72,
          pipeline: 'claude',
        }),
        makeAgentRun({
          id: 73,
          status: 'running',
          issueNumber: 72,
          pipeline: 'codex',
        }),
      ],
    });
    expect(screen.getByTestId('live-run-group-72')).toBeTruthy();
    expect(screen.queryByTestId('live-run-group-72-duplicate')).toBeNull();
  });

  it('links a grouped issue to its canonical task-history route', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      liveRuns: [
        makeAgentRun({ id: 74, status: 'running', issueNumber: 74 }),
        makeAgentRun({ id: 75, status: 'running', issueNumber: 74 }),
      ],
    });
    const link = screen.getByTestId('live-run-group-74-history');
    expect(link.getAttribute('href')).toBe(
      '/task/supersprinklesracing/sprinkles/74',
    );
  });

  it('labels the group with the joined item title when one is known', () => {
    renderPanel(
      [],
      {
        ...EMPTY_ACTIVITY,
        liveRuns: [
          makeAgentRun({ id: 42, status: 'running', issueNumber: 7 }),
          makeAgentRun({
            id: 43,
            status: 'running',
            issueNumber: 7,
            pipeline: 'opencode',
          }),
        ],
      },
      undefined,
      {
        42: {
          number: 7,
          title: 'Fix the thing',
          url: 'https://github.com/o/r/issues/7',
        },
      },
    );
    const group = screen.getByTestId('live-run-group-7');
    expect(group.textContent).toContain('#7 Fix the thing');
  });
});

describe('AgentActivityPanel live run budget gauges', () => {
  it('keeps the actionable wall-clock budget and omits turn/cost metadata', () => {
    renderPanel(
      [],
      {
        ...EMPTY_ACTIVITY,
        liveRuns: [
          makeAgentRun({
            id: 20,
            status: 'running',
            pipeline: 'claude',
            elapsedSeconds: 60,
          }),
        ],
      },
      {
        20: makeIssueAgentSessionDoc({ turns: 42, totalCostUsd: 1.5 }),
      },
    );
    expect(
      screen.getByRole('progressbar', { name: 'Run wall-clock budget' }),
    ).toBeTruthy();
    expect(screen.queryByTestId('live-run-turns')).toBeNull();
    expect(screen.queryByTestId('live-run-cost')).toBeNull();
  });

  it('uses the same uncluttered budget row for opencode runs', () => {
    renderPanel(
      [],
      {
        ...EMPTY_ACTIVITY,
        liveRuns: [
          makeAgentRun({
            id: 21,
            status: 'running',
            pipeline: 'opencode',
            displayTitle: 'opencode #21: Fix it',
          }),
        ],
      },
      {
        21: makeIssueAgentSessionDoc({ totalCostUsd: 0.3 }),
      },
    );
    expect(screen.queryByTestId('live-run-turns')).toBeNull();
    expect(screen.queryByTestId('live-run-cost')).toBeNull();
    expect(
      screen.getByRole('progressbar', { name: 'Run wall-clock budget' }),
    ).toBeTruthy();
  });

  it('renders no budget gauge chrome when no session is joined (PRD story 16)', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      liveRuns: [makeAgentRun({ id: 22, status: 'running' })],
    });
    expect(screen.queryByTestId('live-run-turns')).toBeNull();
    expect(screen.queryByTestId('live-run-cost')).toBeNull();
  });
});

describe('AgentActivityPanel pipeline metadata', () => {
  it('leaves a claude title intact without showing a source tag', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      liveRuns: [
        makeAgentRun({
          id: 1,
          pipeline: 'claude',
          status: 'running',
          displayTitle: '#42: Fix the thing',
        }),
      ],
    });
    expect(screen.queryByText('claude')).toBeNull();
    expect(screen.getByText('#42: Fix the thing')).toBeTruthy();
  });

  it('strips the redundant opencode prefix without showing a source tag', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      liveRuns: [
        makeAgentRun({
          id: 2,
          pipeline: 'opencode',
          status: 'running',
          displayTitle: 'opencode #43: Fix the other thing',
        }),
      ],
    });
    expect(screen.queryByText('opencode')).toBeNull();
    expect(screen.getByText('#43: Fix the other thing')).toBeTruthy();
    expect(screen.queryByText('opencode #43: Fix the other thing')).toBeNull();
  });

  it('strips the dispatch marker from a Bridge run title', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      liveRuns: [
        makeAgentRun({
          id: 4,
          status: 'running',
          displayTitle: '#42: Fix the thing [dispatch:g1:intent-abc]',
        }),
      ],
    });

    expect(screen.getByText('#42: Fix the thing')).toBeTruthy();
    expect(screen.queryByText(/dispatch:g1/)).toBeNull();
  });

  it('keeps recent opencode results equally quiet', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      recentRuns: [
        makeAgentRun({
          id: 3,
          pipeline: 'opencode',
          displayTitle: 'opencode #44: Fix a third thing',
        }),
      ],
    });
    expect(screen.queryByText('opencode')).toBeNull();
    expect(screen.getByText('#44: Fix a third thing')).toBeTruthy();
  });
});

describe('AgentActivityPanel fleet chip', () => {
  it('renders an active-runner count with a busy breakdown when the fleet has online runners', () => {
    renderPanel([], { ...EMPTY_ACTIVITY, fleet: { online: 2, busy: 1 } });
    expect(screen.getByTestId('fleet-chip').textContent).toBe(
      '2 runners active (1 busy)',
    );
  });

  it('renders singular wording and no parenthetical when exactly one runner is online and idle', () => {
    renderPanel([], { ...EMPTY_ACTIVITY, fleet: { online: 1, busy: 0 } });
    expect(screen.getByTestId('fleet-chip').textContent).toBe(
      '1 runner active',
    );
  });

  it('renders nothing when the fleet is scaled to zero - that is normal, not an outage', () => {
    renderPanel([], { ...EMPTY_ACTIVITY, fleet: { online: 0, busy: 0 } });
    expect(screen.queryByTestId('fleet-chip')).toBeNull();
  });

  it('renders an unavailable message when the runner API failed', () => {
    renderPanel([], { ...EMPTY_ACTIVITY, fleet: undefined });
    expect(screen.getByTestId('fleet-chip').textContent).toBe(
      'Runner status unavailable',
    );
  });
});

describe('AgentActivityPanel queue health alert', () => {
  it('warns when a live run has been queued past the stall threshold', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      liveRuns: [
        makeAgentRun({ id: 4, status: 'queued', elapsedSeconds: 301 }),
      ],
    });
    expect(screen.getByTestId('queue-health-alert').textContent).toContain(
      'the runner autoscaler may not be supplying runners.',
    );
  });

  it('says nothing when a queued run is still within a normal spin-up window', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      liveRuns: [makeAgentRun({ id: 5, status: 'queued', elapsedSeconds: 60 })],
    });
    expect(screen.queryByTestId('queue-health-alert')).toBeNull();
  });

  it('says nothing for a running (non-queued) live run, however long it has been running', () => {
    renderPanel([], {
      ...EMPTY_ACTIVITY,
      liveRuns: [
        makeAgentRun({ id: 6, status: 'running', elapsedSeconds: 3600 }),
      ],
    });
    expect(screen.queryByTestId('queue-health-alert')).toBeNull();
  });
});

describe('SourceBadge', () => {
  const renderBadge = (source: SessionSource) =>
    render(
      <MantineProvider>
        <SourceBadge source={source} />
      </MantineProvider>,
    );

  // The label and the color are asserted together because #43's whole point
  // is that they now come from one place: the /sessions table, its mobile
  // card layout, and the session detail header each carried their own
  // inline copy of both, free to drift apart.
  it('renders a cli session in blue', () => {
    const { container } = renderBadge('cli');
    expect(screen.getByText('cli')).toBeTruthy();
    expect(
      container.querySelector('.mantine-Badge-root')?.getAttribute('style'),
    ).toContain('--mantine-color-blue');
  });

  it('renders an issue-agent session as "agent" in violet', () => {
    const { container } = renderBadge('issue-agent');
    expect(screen.getByText('agent')).toBeTruthy();
    expect(
      container.querySelector('.mantine-Badge-root')?.getAttribute('style'),
    ).toContain('--mantine-color-violet');
  });
});
