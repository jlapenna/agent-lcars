import type {
  TranscriptElisionDivider,
  TranscriptTimelineEvent,
} from '@agent-lcars/telemetry';
import { isElisionDivider } from '@agent-lcars/telemetry';
import { Alert, Box, Stack, Text } from '@mantine/core';

import { ConsoleMarkdown } from '../../console-markdown';
import { Eyebrow } from '../../eyebrow';

/** Characters of a long message shown before its expander. The full message is
 * always in the page; this only sets how much is visible while collapsed. */
export const TRANSCRIPT_PREVIEW_CHARS = 2000;

const ROLE_BORDER_COLOR: Record<'user' | 'assistant', string> = {
  user: 'var(--mantine-color-blue-5)',
  assistant: 'var(--mantine-color-gray-5)',
};

function TranscriptEventView({ event }: { event: TranscriptTimelineEvent }) {
  switch (event.kind) {
    case 'text':
      return (
        <Box
          p="xs"
          style={{
            borderLeft: `3px solid ${ROLE_BORDER_COLOR[event.role]}`,
            background: 'var(--mantine-color-default-hover)',
          }}
        >
          <Eyebrow>{event.role}</Eyebrow>
          {event.text.length <= TRANSCRIPT_PREVIEW_CHARS ? (
            <Box fz="sm">
              <ConsoleMarkdown>{event.text}</ConsoleMarkdown>
            </Box>
          ) : (
            <Box className="lcars-transcript-long">
              <Box
                fz="sm"
                className="lcars-transcript-preview"
                data-testid="transcript-preview"
              >
                <ConsoleMarkdown>
                  {`${event.text.slice(0, TRANSCRIPT_PREVIEW_CHARS)}…`}
                </ConsoleMarkdown>
              </Box>
              <details
                className="lcars-disclosure lcars-transcript-disclosure"
                data-testid="transcript-full-text"
              >
                <summary className="lcars-disclosure__summary">
                  <Text size="xs" c="dimmed" component="span">
                    Show full message (
                    {event.text.length.toLocaleString('en-US')} characters)
                  </Text>
                </summary>
                <Box fz="sm">
                  <ConsoleMarkdown>{event.text}</ConsoleMarkdown>
                </Box>
              </details>
            </Box>
          )}
        </Box>
      );

    case 'tool_use':
      return (
        <details className="lcars-disclosure lcars-transcript-disclosure">
          <summary className="lcars-disclosure__summary">
            <Text size="xs" c="dimmed" component="span">
              tool: {event.name}
            </Text>
          </summary>
          <Box
            component="pre"
            p="xs"
            fz="xs"
            style={{ whiteSpace: 'pre-wrap', overflow: 'auto' }}
          >
            {event.inputJson}
          </Box>
        </details>
      );

    case 'tool_result':
      return (
        <details className="lcars-disclosure lcars-transcript-disclosure">
          <summary className="lcars-disclosure__summary">
            <Text size="xs" c="dimmed" component="span">
              tool result
            </Text>
          </summary>
          <Box
            component="pre"
            p="xs"
            fz="xs"
            style={{ whiteSpace: 'pre-wrap', overflow: 'auto' }}
          >
            {event.content}
          </Box>
        </details>
      );

    case 'result':
      return (
        <Alert
          color={event.isError ? 'red' : 'green'}
          variant="light"
          data-testid="transcript-result-banner"
        >
          Result: {event.subtype}
          {event.isError ? ' (error)' : ''}
        </Alert>
      );

    case 'sidechain-group':
      return (
        <details
          className="lcars-disclosure lcars-transcript-disclosure"
          data-testid="transcript-sidechain-group"
        >
          <summary className="lcars-disclosure__summary">
            <Text size="xs" c="dimmed" component="span">
              subagent activity ({event.events.length} events)
            </Text>
          </summary>
          <Stack gap={4} mt="xs" pl="md">
            {event.events.map((nested, i) => (
              <TranscriptEventView key={i} event={nested} />
            ))}
          </Stack>
        </details>
      );
  }
}

/**
 * Renders a parsed transcript timeline (see @agent-lcars/telemetry's
 * transcript-timeline.ts) turn by turn. Long messages, tool blocks and the
 * middle of a single-page timeline render collapsed behind native disclosures.
 */
export function TranscriptTimelineView({
  events,
  warning,
  hasMore = false,
}: {
  events: (TranscriptTimelineEvent | TranscriptElisionDivider)[];
  warning?: string;
  hasMore?: boolean;
}) {
  return (
    <Stack gap="xs" data-testid="transcript-timeline">
      {warning && (
        <Text size="xs" c="orange" data-testid="transcript-warning">
          {warning}
        </Text>
      )}
      {events.length === 0 && !warning && !hasMore && (
        <Text size="sm" c="dimmed">
          No transcript events.
        </Text>
      )}
      {events.map((entry, i) =>
        isElisionDivider(entry) ? (
          <details
            key={`elision-${i}`}
            className="lcars-disclosure lcars-transcript-disclosure"
            data-testid="transcript-elision"
          >
            <summary className="lcars-disclosure__summary">
              <Text size="xs" c="dimmed" component="span">
                Show {entry.elidedCount} more events
              </Text>
            </summary>
            <Stack gap="xs" mt="xs">
              {entry.events.map((nested, j) => (
                <TranscriptEventView key={j} event={nested} />
              ))}
            </Stack>
          </details>
        ) : (
          <TranscriptEventView key={i} event={entry} />
        ),
      )}
    </Stack>
  );
}
