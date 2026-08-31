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
    agent: 'claude-code',
    repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
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
          renderable: true,
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
          renderable: true,
        })}
        transcript={{ events: [] }}
      />,
    );

    expect(screen.getByText('Transcript')).toBeInTheDocument();
    expect(screen.getByTestId('transcript-timeline')).toBeInTheDocument();
    expect(screen.queryByTestId('session-archive-note')).toBeNull();
  });

  it('renders a muted archive note for an unsupported agent', () => {
    renderWithProvider(
      <ArchivedSessionTranscript
        doc={agentDoc({
          agent: 'opencode',
          transcriptGcsUri:
            'gs://supersprinklesracing-agent-session-transcripts/runs/999/opencode/',
          renderable: false,
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

  it('reads doc.renderable rather than re-deriving it from agent (#645 Bug 3)', () => {
    renderWithProvider(
      <ArchivedSessionTranscript
        doc={agentDoc({
          agent: 'codex',
          renderable: true,
          transcriptGcsUri: 'gs://bucket/runs/1/codex/session.jsonl',
        })}
        transcript={{ events: [] }}
      />,
    );

    expect(screen.getByTestId('transcript-timeline')).toBeInTheDocument();
    expect(screen.queryByTestId('session-archive-note')).toBeNull();
  });

  it('renders the archive note when doc.renderable is explicitly false, even for claude-code', () => {
    renderWithProvider(
      <ArchivedSessionTranscript
        doc={agentDoc({
          agent: 'claude-code',
          renderable: false,
          transcriptGcsUri: 'gs://bucket/runs/1/session.jsonl',
        })}
        transcript={{ events: [] }}
      />,
    );

    expect(screen.getByTestId('session-archive-note')).toBeInTheDocument();
    expect(screen.queryByTestId('transcript-timeline')).toBeNull();
  });

  it('keeps an explicitly archive-only Codex doc archive-only', () => {
    renderWithProvider(
      <ArchivedSessionTranscript
        doc={agentDoc({
          agent: 'codex',
          transcriptGcsUri: 'gs://bucket/runs/1/codex/',
          renderable: false,
        })}
        transcript={{ events: [] }}
      />,
    );

    expect(screen.getByTestId('session-archive-note')).toBeInTheDocument();
    expect(screen.queryByTestId('transcript-timeline')).toBeNull();
  });
});
