import type {
  CliSessionDoc,
  IssueAgentSessionDoc,
} from '@agent-lcars/telemetry';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SessionHeader } from './session-header';

// react-markdown/remark-gfm are pulled in transitively via artifact-viewer.tsx
// - ESM-only (unified ecosystem), stubbed the same way as
// agent-activity-panel.test.tsx / artifact-viewer.test.tsx.
vi.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <>{children}</>,
}));
vi.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));

const NOW = '2026-07-10T10:10:00.000Z';

function cliDoc(overrides: Partial<CliSessionDoc> = {}): CliSessionDoc {
  return {
    sessionId: 'cli-1',
    source: 'cli',
    agent: 'claude-code',
    liveness: 'ended',
    startedAt: '2026-07-10T10:00:00.000Z',
    lastActivityAt: '2026-07-10T10:05:00.000Z',
    turns: 4,
    toolCallCounts: {},
    tokens: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 5,
      cacheReadTokens: 10,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
    ...overrides,
  };
}

function agentDoc(
  overrides: Partial<IssueAgentSessionDoc> = {},
): IssueAgentSessionDoc {
  return {
    sessionId: 'agent-1',
    source: 'issue-agent',
    agent: 'claude-code',
    repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
    liveness: 'ended',
    startedAt: '2026-07-10T10:00:00.000Z',
    lastActivityAt: '2026-07-10T10:05:00.000Z',
    turns: 6,
    toolCallCounts: {},
    tokens: {
      inputTokens: 1000,
      outputTokens: 400,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    ...overrides,
  };
}

function renderHeader(doc: CliSessionDoc | IssueAgentSessionDoc) {
  render(
    <MantineProvider>
      <SessionHeader doc={doc} now={NOW} />
    </MantineProvider>,
  );
}

describe('SessionHeader', () => {
  it('keeps its details below the shared page heading', () => {
    renderHeader(cliDoc({ title: 'Fix flaky login test' }));
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('renders CLI host/cwd/worktree/branch fields', () => {
    renderHeader(
      cliDoc({
        host: 'joes-workstation',
        cwd: '/home/dev/project',
        worktree: 'feat-x',
        branch: 'feat/x',
      }),
    );
    expect(screen.getByText('joes-workstation')).toBeTruthy();
    expect(screen.getByText('/home/dev/project')).toBeTruthy();
    expect(screen.getByText('feat-x')).toBeTruthy();
    expect(screen.getByText('feat/x')).toBeTruthy();
  });

  it('renders the CLI-only summary-only note', () => {
    renderHeader(cliDoc());
    expect(screen.getByTestId('cli-summary-note')).toBeTruthy();
  });

  it('renders issue-agent run and issue links, and no summary-only note', () => {
    renderHeader(agentDoc({ runId: '999', issueNumber: 42 }));

    const runLink = screen.getByRole('link', { name: /#999/ });
    expect(runLink.getAttribute('href')).toBe(
      'https://github.com/supersprinklesracing/sprinkles/actions/runs/999',
    );
    const issueLink = screen.getByRole('link', { name: '#42' });
    expect(issueLink.getAttribute('href')).toBe(
      'https://github.com/supersprinklesracing/sprinkles/issues/42',
    );
    expect(screen.queryByTestId('cli-summary-note')).toBeNull();
  });

  it('renders an opaque broker run ID without an Actions link', () => {
    renderHeader(agentDoc({ runId: 'sprinkles/4829/r-queue-123' }));

    expect(screen.getByText('sprinkles/4829/r-queue-123')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /r-queue-123/ })).toBeNull();
  });

  it('renders a full token breakdown including cost-weighted cache tokens', () => {
    renderHeader(cliDoc());
    expect(
      screen.getByText(
        /157 cost-weighted total \(in 100, out 50, cache-create 5, cache-read 10\)/,
      ),
    ).toBeTruthy();
  });

  it('omits cache token breakdown when both are zero', () => {
    renderHeader(
      agentDoc({
        tokens: {
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      }),
    );
    expect(
      screen.getByText('15 cost-weighted total (in 10, out 5)'),
    ).toBeTruthy();
  });

  it('shows an em-dash for cost when the doc has none, and a formatted cost when it does', () => {
    renderHeader(cliDoc({ totalCostUsd: 2.5 }));
    expect(screen.getByText('$2.50')).toBeTruthy();
  });

  it('renders deliverables (branch, PR links, commit shas) when present', () => {
    renderHeader(
      cliDoc({
        deliverables: {
          branch: 'feat/x',
          prNumbers: [99],
          commitShas: ['abc1234'],
        },
      }),
    );
    const prLink = screen.getByRole('link', { name: /PR #99/ });
    expect(prLink.getAttribute('href')).toBe(
      'https://github.com/supersprinklesracing/sprinkles/pull/99',
    );
    expect(screen.getByText(/abc1234/)).toBeTruthy();
  });

  it('renders no deliverables section when there are none', () => {
    renderHeader(cliDoc());
    expect(screen.queryByText('Deliverables')).toBeNull();
  });

  it('renders artifact links for a CLI session with a host and artifacts', () => {
    renderHeader(
      cliDoc({ host: 'pike', artifacts: ['report.md'], sessionId: 'abc-123' }),
    );
    const link = screen.getByRole('link', { name: /report\.md/ });
    expect(link.getAttribute('href')).toBe(
      'https://share.lan.jlapenna.net/pike/abc-123/report.md',
    );
  });

  it('renders the liveness badge, recomputed from now', () => {
    renderHeader(cliDoc({ lastActivityAt: NOW }));
    expect(screen.getByTestId('session-header-liveness').textContent).toBe(
      'live',
    );
  });

  it('renders the agent-declared status with its own age under the badges (#1257)', () => {
    renderHeader(
      cliDoc({
        lastActivityAt: NOW,
        status: 'waiting on CI for #1247',
        statusUpdatedAt: '2026-07-10T10:08:00.000Z',
      }),
    );

    expect(screen.getByTestId('session-status-line')).toBeTruthy();
    expect(screen.getByText('waiting on CI for #1247')).toBeTruthy();
  });

  it('hides the status line once the session has ended (#1257)', () => {
    renderHeader(
      cliDoc({
        liveness: 'ended',
        // Far enough before NOW that displayLiveness's recency override
        // (a doc is 'live' whenever lastActivityAt is within 5m of now,
        // regardless of the stored value) doesn't kick in and mask the
        // stored 'ended' state - see liveness.ts's DISPLAY_LIVE_THRESHOLD_MS.
        lastActivityAt: '2026-07-01T00:00:00.000Z',
        status: 'waiting on CI for #1247',
        statusUpdatedAt: '2026-07-10T10:08:00.000Z',
      }),
    );

    expect(screen.queryByTestId('session-status-line')).toBeNull();
  });

  it('renders nothing extra when the doc has no declared status (#1257)', () => {
    renderHeader(cliDoc({ lastActivityAt: NOW }));
    expect(screen.queryByTestId('session-status-line')).toBeNull();
  });

  it('renders a resume-archive command for an issue-agent session with a transcriptGcsUri (#3107)', () => {
    renderHeader(
      agentDoc({
        transcriptGcsUri:
          'gs://supersprinklesracing-agent-session-transcripts/runs/999/agent-1.jsonl',
        renderable: true,
      }),
    );

    expect(
      screen.getByRole('button', { name: 'Copy takeover command' }),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        'tools/claude-agent-session.sh resume-archive gs://supersprinklesracing-agent-session-transcripts/runs/999/agent-1.jsonl',
      ),
    ).toBeNull();
  });

  it('offers no Claude resume command for an archived Codex session', () => {
    renderHeader(
      agentDoc({
        agent: 'codex',
        transcriptGcsUri:
          'gs://agent-lcars-agent-session-transcripts/runs/5150/codex.jsonl',
        renderable: false,
      }),
    );

    // resume-archive installs the JSONL under ~/.claude/projects and runs
    // `claude --resume`; it cannot resume a Codex rollout, so offering it
    // would be a command that silently does the wrong thing.
    expect(screen.queryByText(/resume-archive/)).toBeNull();
    // The archive location is still surfaced - just without a command.
    const note = screen.getByTestId('archive-no-resume-note');
    expect(note.textContent).toContain(
      'gs://agent-lcars-agent-session-transcripts/runs/5150/codex.jsonl',
    );
  });

  it('omits the resume-archive command for an issue-agent session with no transcriptGcsUri', () => {
    renderHeader(agentDoc());
    expect(screen.queryByText(/resume-archive/)).toBeNull();
  });

  it('omits the resume-archive command for a cli session even if transcriptGcsUri were somehow present', () => {
    renderHeader(cliDoc());
    expect(screen.queryByText(/resume-archive/)).toBeNull();
  });

  it('renders the explicit claude-code identity', () => {
    renderHeader(cliDoc({ agent: 'claude-code' }));
    expect(screen.getByText('claude code')).toBeTruthy();
  });

  it('renders the explicit antigravity identity', () => {
    renderHeader(agentDoc({ agent: 'antigravity' }));
    expect(screen.getByText('antigravity')).toBeTruthy();
  });
});
