import { MantineProvider } from '@mantine/core';
import type { TranscriptTimelineEvent } from '@agent-lcars/telemetry';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TranscriptTimelineView } from './transcript-timeline-view';

function renderTimeline(
  events: Parameters<typeof TranscriptTimelineView>[0]['events'],
  warning?: string,
) {
  render(
    <MantineProvider>
      <TranscriptTimelineView events={events} warning={warning} />
    </MantineProvider>,
  );
}

describe('TranscriptTimelineView', () => {
  it('renders an empty state with no events and no warning', () => {
    renderTimeline([]);
    expect(screen.getByText('No transcript events.')).toBeTruthy();
  });

  it('renders a warning line when present, even with events', () => {
    renderTimeline(
      [{ kind: 'text', role: 'user', text: 'hi' }],
      'Some transcript lines could not be parsed and were skipped.',
    );
    expect(screen.getByTestId('transcript-warning').textContent).toContain(
      'could not be parsed',
    );
  });

  it('renders user and assistant text blocks with their role label', () => {
    renderTimeline([
      { kind: 'text', role: 'user', text: 'Fix the bug' },
      { kind: 'text', role: 'assistant', text: 'On it.' },
    ]);
    expect(screen.getByText('Fix the bug')).toBeTruthy();
    expect(screen.getByText('On it.')).toBeTruthy();
    expect(screen.getByText('user')).toBeTruthy();
    expect(screen.getByText('assistant')).toBeTruthy();
  });

  it('renders a tool_use event as a collapsed details block with the tool name', () => {
    renderTimeline([
      { kind: 'tool_use', name: 'Bash', inputJson: '{"command":"npm test"}' },
    ]);
    expect(screen.getByText('tool: Bash')).toBeTruthy();
    expect(screen.getByText('{"command":"npm test"}')).toBeTruthy();
  });

  it('renders a tool_result event as a collapsed details block', () => {
    renderTimeline([{ kind: 'tool_result', content: '1 test failed' }]);
    expect(screen.getByText('tool result')).toBeTruthy();
    expect(screen.getByText('1 test failed')).toBeTruthy();
  });

  it('renders a result line as a status banner, colored by isError', () => {
    renderTimeline([{ kind: 'result', subtype: 'success', isError: false }]);
    const banner = screen.getByTestId('transcript-result-banner');
    expect(banner.textContent).toContain('success');
    expect(banner.textContent).not.toContain('(error)');
  });

  it('marks an error result banner distinctly', () => {
    renderTimeline([
      { kind: 'result', subtype: 'error_during_execution', isError: true },
    ]);
    expect(
      screen.getByTestId('transcript-result-banner').textContent,
    ).toContain('(error)');
  });

  it('groups sidechain events under one collapsed "subagent activity" block', () => {
    const sidechainEvents: TranscriptTimelineEvent[] = [
      { kind: 'tool_use', name: 'Grep', inputJson: '{"pattern":"flaky"}' },
      { kind: 'tool_result', content: '3 matches' },
    ];
    renderTimeline([{ kind: 'sidechain-group', events: sidechainEvents }]);

    expect(screen.getByText('subagent activity (2 events)')).toBeTruthy();
    expect(screen.getByText('tool: Grep')).toBeTruthy();
  });

  it('renders an elision divider with the elided count', () => {
    renderTimeline([
      { kind: 'text', role: 'user', text: 'start' },
      { kind: 'elision', elidedCount: 250 },
      { kind: 'text', role: 'assistant', text: 'end' },
    ]);
    expect(screen.getByTestId('transcript-elision').textContent).toContain(
      '250 events elided',
    );
  });
});
