import type {
  IssueAgentSessionDoc,
  SessionAgent,
  SessionSource,
} from '@agent-lcars/telemetry';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRun } from '../lib/agent-activity';
import type { CliSession } from '../lib/cli-sessions';
import {
  AgentBadge,
  CliSessionRow,
  duplicatePipelineSummary,
  FinishedRunRow,
  FleetChip,
  isActiveCliSession,
  LiveRunRow,
  PipelineBadge,
  QueueHealthAlert,
  SourceBadge,
} from './agent-activity-panel';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(''),
}));

// agent-activity.ts pulls in the server-only (ESM) GitHub client - stub the
// runtime values these row/alert components actually use so the module never
// loads (and its assertNotBrowser() guard never fires) at test time.
vi.mock('../lib/agent-activity', () => ({
  RUN_TIMEOUT_MINUTES: 120,
  MAX_TURNS_BUDGET: 200,
  findStalledQueuedRun: (liveRuns: AgentRun[]) =>
    liveRuns
      .filter((run) => run.status === 'queued' && run.elapsedSeconds > 300)
      .sort((a, b) => b.elapsedSeconds - a.elapsedSeconds)[0],
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
}));

// react-markdown/remark-gfm (pulled in via artifact-viewer.tsx) are ESM-only
// (unified ecosystem) - see artifact-viewer.test.tsx for the same stub.
vi.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <>{children}</>,
}));
vi.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));

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

function makeAgentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
    pipeline: 'claude',
    status: 'completed',
    conclusion: 'success',
    url: '/runs/run-1',
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

describe('CliSessionRow operations variant', () => {
  it('identifies live/idle sessions as active and ended/stale as inactive', () => {
    expect(isActiveCliSession(makeCliSession({ liveness: 'live' }))).toBe(true);
    expect(isActiveCliSession(makeCliSession({ liveness: 'idle' }))).toBe(true);
    expect(isActiveCliSession(makeCliSession({ liveness: 'ended' }))).toBe(
      false,
    );
    expect(isActiveCliSession(makeCliSession({ liveness: 'stale' }))).toBe(
      false,
    );
  });

  it('renders an active CLI session without host, worktree, model, turn, or token metadata (#3012)', () => {
    render(
      <MantineProvider>
        <CliSessionRow
          session={makeCliSession({
            title: 'Merge live CLI sessions into the list',
            model: 'claude-sonnet-5',
            turns: 4,
            totalTokens: 1200,
            pr: { number: 2587, url: 'https://github.com/o/r/pull/2587' },
            artifacts: ['report.md', 'chart.png'],
          })}
          variant="operations"
        />
      </MantineProvider>,
    );

    expect(screen.getByText('live')).toBeTruthy();
    expect(
      screen.getByText('Merge live CLI sessions into the list'),
    ).toBeTruthy();
    expect(screen.queryByText('joes-workstation')).toBeNull();
    expect(screen.queryByText(/feat\/agent-lcars-cli-sessions/)).toBeNull();
    expect(screen.queryByText('claude-sonnet-5')).toBeNull();
    expect(screen.queryByText('4 turns')).toBeNull();
    expect(screen.queryByText('1.2k tokens')).toBeNull();
    expect(screen.queryByRole('link', { name: /PR #2587/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /report\.md/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open session' })).toBeTruthy();
  });

  it('always links to the session detail page and avoids exposing a raw UUID label', () => {
    render(
      <MantineProvider>
        <CliSessionRow
          session={makeCliSession({
            sessionId: '34e381cd-aaaa-bbbb-cccc-123456789abc',
            title: undefined,
            branch: undefined,
            host: 'pike',
          })}
          variant="operations"
        />
      </MantineProvider>,
    );

    expect(screen.getByText('Session on pike')).toBeTruthy();
    expect(
      screen.queryByText('34e381cd-aaaa-bbbb-cccc-123456789abc'),
    ).toBeNull();
    expect(screen.getByTestId('cli-session-link')).toHaveAttribute(
      'href',
      '/sessions/34e381cd-aaaa-bbbb-cccc-123456789abc',
    );
    expect(screen.getByTestId('cli-session-liveness').style.flexShrink).toBe(
      '0',
    );
  });

  it('renders the agent-declared status with its own age under the title (#1257)', () => {
    render(
      <MantineProvider>
        <CliSessionRow
          session={makeCliSession({
            liveness: 'live',
            title: 'Land session titles end to end',
            status: 'waiting on CI for #1247',
            statusUpdatedAt: '2026-07-12T00:03:00.000Z',
          })}
          variant="operations"
        />
      </MantineProvider>,
    );

    expect(screen.getByTestId('session-status-line')).toBeTruthy();
    expect(screen.getByText('waiting on CI for #1247')).toBeTruthy();
  });

  it('renders no status line for a live session with no declared status (#1257)', () => {
    render(
      <MantineProvider>
        <CliSessionRow
          session={makeCliSession({ liveness: 'live' })}
          variant="operations"
        />
      </MantineProvider>,
    );
    expect(screen.queryByTestId('session-status-line')).toBeNull();
  });
});

describe('CliSessionRow detail variant', () => {
  it('renders the agent-declared status with its own age under the title', () => {
    render(
      <MantineProvider>
        <CliSessionRow
          session={makeCliSession({
            liveness: 'live',
            title: 'Land session titles end to end',
            status: 'waiting on CI for #1247',
            statusUpdatedAt: '2026-07-12T00:03:00.000Z',
          })}
        />
      </MantineProvider>,
    );

    expect(screen.getByTestId('session-status-line')).toBeTruthy();
    expect(screen.getByText('waiting on CI for #1247')).toBeTruthy();
  });

  it('hides the status line once the session has ended', () => {
    render(
      <MantineProvider>
        <CliSessionRow
          session={makeCliSession({
            liveness: 'ended',
            status: 'waiting on CI for #1247',
            statusUpdatedAt: '2026-07-12T00:03:00.000Z',
          })}
        />
      </MantineProvider>,
    );

    expect(screen.queryByTestId('session-status-line')).toBeNull();
  });

  it('renders no artifacts section when the session has none', () => {
    render(
      <MantineProvider>
        <CliSessionRow session={makeCliSession({ artifacts: [] })} />
      </MantineProvider>,
    );
    expect(screen.queryByText('Artifacts:')).toBeNull();
  });
});

describe('FinishedRunRow', () => {
  it('keeps the recent-run conclusion badge from shrinking away on narrow layouts', () => {
    render(
      <MantineProvider>
        <FinishedRunRow run={makeAgentRun()} />
      </MantineProvider>,
    );
    const badge = screen.getByTestId('recent-run-conclusion');
    expect(badge.style.flexShrink).toBe('0');
    expect(badge.textContent).toBe('success');
  });

  it('links a finished native work item run to its /work/<id> page (#1530)', () => {
    render(
      <MantineProvider>
        <FinishedRunRow
          run={makeAgentRun({
            id: '50',
            status: 'completed',
            conclusion: 'success',
            issueNumber: undefined,
            workId: '01M107KR3X6VDH7NZ4JDXZNSS2',
            displayTitle: 'Native work: fix console model',
          })}
        />
      </MantineProvider>,
    );

    const link = screen.getByTestId('recent-run-issue-link');
    expect(link.getAttribute('href')).toBe('/work/01M107KR3X6VDH7NZ4JDXZNSS2');
    expect(link.textContent).toBe('Native work: fix console model');
  });

  it('shows a plain "cancelled" badge for a quick cancel, and "timeout" for a near-budget one', () => {
    const { rerender } = render(
      <MantineProvider>
        <FinishedRunRow
          run={makeAgentRun({
            id: '10',
            conclusion: 'cancelled',
            elapsedSeconds: 5,
          })}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('recent-run-conclusion').textContent).toBe(
      'cancelled',
    );

    rerender(
      <MantineProvider>
        <FinishedRunRow
          run={makeAgentRun({
            id: '11',
            conclusion: 'cancelled',
            elapsedSeconds: 120 * 60,
          })}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('recent-run-conclusion').textContent).toBe(
      'timeout',
    );
  });

  it('shows a "silent error" badge and diagnosis when the joined session flags a known error signature despite a success conclusion', () => {
    render(
      <MantineProvider>
        <FinishedRunRow
          run={makeAgentRun({ id: '12', conclusion: 'success' })}
          session={makeIssueAgentSessionDoc({
            result: { subtype: 'error_max_turns', isError: true },
          })}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('recent-run-conclusion').textContent).toBe(
      'silent error',
    );
    expect(screen.getByTestId('finished-run-diagnosis').textContent).toContain(
      'failure signature',
    );
  });

  it('shows a "silent error" badge when the joined session recorded zero turns despite a success conclusion', () => {
    render(
      <MantineProvider>
        <FinishedRunRow
          run={makeAgentRun({ id: '15', conclusion: 'success' })}
          session={makeIssueAgentSessionDoc({ turns: 0 })}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('recent-run-conclusion').textContent).toBe(
      'silent error',
    );
    expect(screen.getByTestId('finished-run-diagnosis').textContent).toContain(
      'zero turns',
    );
  });

  it('does not flag a success run whose session shows real turns but no PR/commit (e.g. a comment-only reply)', () => {
    render(
      <MantineProvider>
        <FinishedRunRow
          run={makeAgentRun({ id: '14', conclusion: 'success' })}
          session={makeIssueAgentSessionDoc({
            turns: 3,
            deliverables: { prNumbers: [], commitShas: [] },
          })}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('recent-run-conclusion').textContent).toBe(
      'success',
    );
    expect(screen.queryByTestId('finished-run-diagnosis')).toBeNull();
    expect(screen.getByTestId('finished-run-session-link')).toHaveAttribute(
      'href',
      '/sessions/session-runner-1',
    );
  });

  it('renders no diagnosis or session link for an ordinary success with no joined session', () => {
    render(
      <MantineProvider>
        <FinishedRunRow
          run={makeAgentRun({ id: '13', conclusion: 'success' })}
        />
      </MantineProvider>,
    );
    expect(screen.queryByTestId('finished-run-diagnosis')).toBeNull();
    expect(screen.queryByTestId('finished-run-session-link')).toBeNull();
  });
});

describe('LiveRunRow', () => {
  it('links a native work item run to its /work/<id> page (#1530)', () => {
    render(
      <MantineProvider>
        <LiveRunRow
          run={makeAgentRun({
            id: '40',
            status: 'running',
            issueNumber: undefined,
            workId: '01M107KR3X6VDH7NZ4JDXZNSS2',
            displayTitle: 'Native work: fix console model',
          })}
        />
      </MantineProvider>,
    );

    const link = screen.getByTestId('live-run-issue-link');
    expect(link.getAttribute('href')).toBe('/work/01M107KR3X6VDH7NZ4JDXZNSS2');
    expect(link.textContent).toBe('Native work: fix console model');
  });

  it('inspects an unanchored run onsite when no task target is available', () => {
    render(
      <MantineProvider>
        <LiveRunRow
          run={makeAgentRun({
            id: '41',
            status: 'running',
            issueNumber: undefined,
          })}
        />
      </MantineProvider>,
    );

    const link = screen.getByTestId('live-run-issue-link');
    expect(link.getAttribute('href')).toBe(
      '/agents?repo=supersprinklesracing%2Fsprinkles&sel=run%3A41',
    );
  });

  it('renders wall-clock, turns (for claude), and cost gauges when joined to a session', () => {
    const { rerender } = render(
      <MantineProvider>
        <LiveRunRow
          run={makeAgentRun({
            id: '20',
            status: 'running',
            pipeline: 'claude',
            elapsedSeconds: 60,
          })}
          session={makeIssueAgentSessionDoc({ turns: 42, totalCostUsd: 1.5 })}
        />
      </MantineProvider>,
    );
    expect(
      screen.getByRole('progressbar', { name: 'Run wall-clock budget' }),
    ).toBeTruthy();
    expect(screen.getByTestId('live-run-turns').textContent).toBe(
      '42 of 200 turns',
    );
    expect(screen.getByTestId('live-run-cost').textContent).toBe('$1.50');

    rerender(
      <MantineProvider>
        <LiveRunRow
          run={makeAgentRun({
            id: '21',
            status: 'running',
            pipeline: 'opencode',
          })}
          session={makeIssueAgentSessionDoc({ totalCostUsd: 0.3 })}
        />
      </MantineProvider>,
    );
    expect(screen.queryByTestId('live-run-turns')).toBeNull();
    expect(screen.getByTestId('live-run-cost').textContent).toBe('$0.30');
  });

  it('renders no turn/cost chrome when no session is joined (PRD story 16)', () => {
    render(
      <MantineProvider>
        <LiveRunRow run={makeAgentRun({ id: '22', status: 'running' })} />
      </MantineProvider>,
    );
    expect(screen.queryByTestId('live-run-turns')).toBeNull();
    expect(screen.queryByTestId('live-run-cost')).toBeNull();
    expect(screen.queryByTestId('live-run-session-link')).toBeNull();
  });
});

describe('duplicatePipelineSummary and QueueHealthAlert', () => {
  it('summarizes duplicate live pipelines without flagging cross-pipeline races (#306)', () => {
    expect(
      duplicatePipelineSummary([
        makeAgentRun({ id: '70', status: 'queued', pipeline: 'claude' }),
        makeAgentRun({ id: '71', status: 'running', pipeline: 'claude' }),
      ]),
    ).toBe('2 claude');

    expect(
      duplicatePipelineSummary([
        makeAgentRun({ id: '72', status: 'running', pipeline: 'claude' }),
        makeAgentRun({ id: '73', status: 'running', pipeline: 'codex' }),
      ]),
    ).toBeUndefined();
  });

  it('warns only when a queued live run exceeds the stall threshold', () => {
    const { rerender } = render(
      <MantineProvider>
        <QueueHealthAlert
          liveRuns={[
            makeAgentRun({ id: '4', status: 'queued', elapsedSeconds: 301 }),
          ]}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('queue-health-alert').textContent).toContain(
      'the runner autoscaler may not be supplying runners.',
    );

    rerender(
      <MantineProvider>
        <QueueHealthAlert
          liveRuns={[
            makeAgentRun({ id: '5', status: 'queued', elapsedSeconds: 60 }),
            makeAgentRun({ id: '6', status: 'running', elapsedSeconds: 3600 }),
          ]}
        />
      </MantineProvider>,
    );
    expect(screen.queryByTestId('queue-health-alert')).toBeNull();
  });
});

describe('Badges and FleetChip', () => {
  it.each([
    ['claude-code', 'claude code'],
    ['codex', 'codex'],
    ['gemini', 'gemini'],
    ['antigravity', 'antigravity'],
    ['opencode', 'opencode'],
  ] as const satisfies readonly [SessionAgent, string][])(
    'renders the persisted %s agent identity',
    (agent, label) => {
      render(
        <MantineProvider>
          <AgentBadge agent={agent} />
        </MantineProvider>,
      );
      expect(screen.getByText(label)).toBeTruthy();
    },
  );

  it('names internal recipe, summary and claw pipelines on PipelineBadge', () => {
    render(
      <MantineProvider>
        <PipelineBadge pipeline="goose" />
        <PipelineBadge pipeline="inbox-summary" />
        <PipelineBadge pipeline="handoff-summary" />
        <PipelineBadge pipeline="claw-investigator" />
        <PipelineBadge pipeline="claw-default" />
      </MantineProvider>,
    );
    expect(screen.getByText('claw investigator')).toBeTruthy();
    expect(screen.getByText('claw default')).toBeTruthy();
    expect(screen.getByText('goose')).toBeTruthy();
    expect(screen.getByText('inbox summary')).toBeTruthy();
    expect(screen.getByText('handoff summary')).toBeTruthy();
  });

  it('renders SourceBadge for cli and issue-agent sessions', () => {
    const renderBadge = (source: SessionSource) =>
      render(
        <MantineProvider>
          <SourceBadge source={source} />
        </MantineProvider>,
      );

    const cli = renderBadge('cli');
    expect(screen.getByText('cli')).toBeTruthy();
    expect(
      cli.container.querySelector('.mantine-Badge-root')?.getAttribute('style'),
    ).toContain('--mantine-color-blue');
    cli.unmount();

    const issueAgent = renderBadge('issue-agent');
    expect(screen.getByText('agent')).toBeTruthy();
    expect(
      issueAgent.container
        .querySelector('.mantine-Badge-root')
        ?.getAttribute('style'),
    ).toContain('--mantine-color-violet');
  });

  it('renders FleetChip states accurately', () => {
    const expires = new Date(Date.now() + 180_000).toISOString();
    const { rerender } = render(
      <MantineProvider>
        <FleetChip fleet={{ online: 2, busy: 1, githubExpiresAt: expires }} />
      </MantineProvider>,
    );
    expect(screen.getByTestId('fleet-chip').textContent).toBe(
      '2 GitHub runners online (1 running) · Direct executor status unavailable',
    );

    rerender(
      <MantineProvider>
        <FleetChip fleet={{ online: 1, busy: 0, githubExpiresAt: expires }} />
      </MantineProvider>,
    );
    expect(screen.getByTestId('fleet-chip').textContent).toBe(
      '1 GitHub runner online (0 running) · Direct executor status unavailable',
    );

    rerender(
      <MantineProvider>
        <FleetChip
          fleet={{
            directExecutor: {
              ready: true,
              maxConcurrent: 3,
              expiresAt: expires,
            },
          }}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('fleet-chip')).toHaveTextContent(
      'GitHub runner status unavailable · Direct executor ready (limit 3)',
    );

    rerender(
      <MantineProvider>
        <FleetChip fleet={undefined} />
      </MantineProvider>,
    );
    expect(screen.getByTestId('fleet-chip').textContent).toBe(
      'Runner status unavailable',
    );
  });
});

describe('Agents title navigation', () => {
  it('opens a known projected task title on its task page', () => {
    render(
      <MantineProvider>
        <LiveRunRow
          run={makeAgentRun({ issueNumber: 42 })}
          item={{
            number: 42,
            title: 'Fix the thing',
            url: 'https://github.com/o/r/issues/42',
          }}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('live-run-issue-link')).toHaveAttribute(
      'href',
      '/task/supersprinklesracing/sprinkles/42',
    );
  });

  it('keeps authoritative native Work identity even if an item is supplied', () => {
    render(
      <MantineProvider>
        <LiveRunRow
          run={makeAgentRun({ workId: '01M107KR3X6VDH7NZ4JDXZNSS2' })}
          item={{
            number: 42,
            title: 'Fix the thing',
            url: 'https://github.com/o/r/issues/42',
          }}
        />
      </MantineProvider>,
    );
    expect(screen.getByTestId('live-run-issue-link')).toHaveAttribute(
      'href',
      '/work/01M107KR3X6VDH7NZ4JDXZNSS2',
    );
  });

  it.each([
    ['live', LiveRunRow, 'live-run-issue-link'],
    ['finished', FinishedRunRow, 'recent-run-issue-link'],
  ] as const)(
    'inspects %s GitHub runs onsite without a task projection',
    (_name, Row, testId) => {
      const run = makeAgentRun({
        issueNumber: 42,
        url: 'https://github.com/supersprinklesracing/sprinkles/issues/42',
      });
      render(
        <MantineProvider>
          <Row run={run} />
        </MantineProvider>,
      );
      const title = screen.getByTestId(testId);
      expect(title).toHaveAttribute(
        'href',
        '/agents?repo=supersprinklesracing%2Fsprinkles&sel=run%3Arun-1',
      );
      expect(title).not.toHaveAttribute('target');
      const githubLinks = screen
        .getAllByRole('link')
        .filter((link) =>
          link.getAttribute('href')?.startsWith('https://github.com/'),
        );
      expect(githubLinks).toHaveLength(1);
      for (const link of githubLinks) {
        expect(link).toHaveTextContent('GitHub');
      }
    },
  );
});

describe('CliSessionRow live view link', () => {
  const OVIS = 'AGENT_LCARS_OVIS_URL_BY_HOST';
  afterEach(() => {
    delete process.env[OVIS];
  });

  it('links a live session with a herdr pane to its host Ovis', () => {
    process.env[OVIS] = '{"pike":"https://herdr.example.test"}';
    render(
      <MantineProvider>
        <CliSessionRow
          session={makeCliSession({ host: 'pike', herdrPaneId: 't36' })}
        />
      </MantineProvider>,
    );
    const link = screen.getByTestId('cli-session-live-view');
    expect(link.getAttribute('href')).toBe(
      'https://herdr.example.test/?pane=t36&view=chat',
    );
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('shows no link without a pane, or once the session has ended', () => {
    process.env[OVIS] = '{"pike":"https://herdr.example.test"}';
    for (const session of [
      makeCliSession({ host: 'pike' }),
      makeCliSession({ host: 'pike', herdrPaneId: 't36', liveness: 'ended' }),
    ]) {
      const { unmount } = render(
        <MantineProvider>
          <CliSessionRow session={session} />
        </MantineProvider>,
      );
      expect(screen.queryByTestId('cli-session-live-view')).toBeNull();
      unmount();
    }
  });
});
