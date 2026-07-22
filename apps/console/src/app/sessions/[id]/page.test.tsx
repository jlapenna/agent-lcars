import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { ArchivedSessionTranscript } from './page';

function agentDoc(
  overrides: Partial<IssueAgentSessionDoc> = {},
): IssueAgentSessionDoc {
  return {
    sessionId: 'agent-1',
    source: 'issue-agent',
    liveness: 'ended',
    startedAt: '2026-07-19T10:00:00.000Z',
    lastActivityAt: '2026-07-19T10:05:00.000Z',
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

function renderWithProvider(ui: ReactElement) {
  return render(<MantineProvider>{ui}</MantineProvider>);
}

describe('ArchivedSessionTranscript', () => {
  it('renders nothing when the doc has no transcriptGcsUri', () => {
    renderWithProvider(<ArchivedSessionTranscript doc={agentDoc()} />);
    expect(screen.queryByTestId('transcript-timeline')).toBeNull();
    expect(screen.queryByTestId('session-archive-note')).toBeNull();
  });

  it('renders nothing for a claude-code doc whose transcript has not loaded', () => {
    renderWithProvider(
      <ArchivedSessionTranscript
        doc={agentDoc({
          agent: 'claude-code',
          transcriptGcsUri: 'gs://bucket/runs/1/session.jsonl',
        })}
      />,
    );
    expect(screen.queryByTestId('transcript-timeline')).toBeNull();
    expect(screen.queryByTestId('session-archive-note')).toBeNull();
  });

  it('renders the transcript timeline for a claude-code doc with a loaded transcript', () => {
    renderWithProvider(
      <ArchivedSessionTranscript
        doc={agentDoc({
          agent: 'claude-code',
          transcriptGcsUri: 'gs://bucket/runs/1/session.jsonl',
        })}
        transcript={{ events: [] }}
      />,
    );

    expect(screen.getByText('Transcript')).toBeInTheDocument();
    expect(screen.getByTestId('transcript-timeline')).toBeInTheDocument();
    expect(screen.queryByTestId('session-archive-note')).toBeNull();
  });

  it('renders the transcript timeline for a legacy doc with no agent field (defaults to claude-code)', () => {
    renderWithProvider(
      <ArchivedSessionTranscript
        doc={agentDoc({ transcriptGcsUri: 'gs://bucket/runs/1/session.jsonl' })}
        transcript={{ events: [] }}
      />,
    );

    expect(screen.getByTestId('transcript-timeline')).toBeInTheDocument();
  });

  it('renders a muted archive note (not the transcript timeline) for a non-claude-code agent', () => {
    renderWithProvider(
      <ArchivedSessionTranscript
        doc={agentDoc({
          agent: 'opencode',
          transcriptGcsUri:
            'gs://supersprinklesracing-agent-session-transcripts/runs/999/opencode/',
        })}
      />,
    );

    expect(screen.getByTestId('session-archive-note')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Session archive stored (opencode format) — not yet renderable',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('session-archive-uri')).toHaveTextContent(
      'gs://supersprinklesracing-agent-session-transcripts/runs/999/opencode/',
    );
    expect(screen.queryByTestId('transcript-timeline')).toBeNull();
  });

  it('renders the archive note for a non-claude-code agent even when a transcript happens to be present', () => {
    // Defensive: session-detail.ts never fetches a transcript for a
    // non-claude-code doc, but this component must not render it as a
    // transcript even if a caller passed one anyway.
    renderWithProvider(
      <ArchivedSessionTranscript
        doc={agentDoc({
          agent: 'codex',
          transcriptGcsUri: 'gs://bucket/runs/1/codex/',
        })}
        transcript={{ events: [] }}
      />,
    );

    expect(screen.getByTestId('session-archive-note')).toBeInTheDocument();
    expect(screen.queryByTestId('transcript-timeline')).toBeNull();
  });
});
