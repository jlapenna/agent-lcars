import { MantineProvider } from '@mantine/core';
import type {
  CliSessionDoc,
  IssueAgentSessionDoc,
} from '@repo/agent-telemetry';
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
    ...overrides,
  };
}

function agentDoc(
  overrides: Partial<IssueAgentSessionDoc> = {},
): IssueAgentSessionDoc {
  return {
    sessionId: 'agent-1',
    source: 'issue-agent',
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
  it('renders the title, or falls back to the sessionId', () => {
    renderHeader(cliDoc({ title: 'Fix flaky login test' }));
    expect(screen.getByText('Fix flaky login test')).toBeTruthy();
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
      'https://github.com/supersprinklesracing/members/actions/runs/999',
    );
    const issueLink = screen.getByRole('link', { name: '#42' });
    expect(issueLink.getAttribute('href')).toBe(
      'https://github.com/supersprinklesracing/members/issues/42',
    );
    expect(screen.queryByTestId('cli-summary-note')).toBeNull();
  });

  it('renders a full token breakdown including cache tokens when present', () => {
    renderHeader(cliDoc());
    expect(
      screen.getByText(
        /150 total \(in 100, out 50, cache-create 5, cache-read 10\)/,
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
    expect(screen.getByText('15 total (in 10, out 5)')).toBeTruthy();
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
      'https://github.com/supersprinklesracing/members/pull/99',
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
});
