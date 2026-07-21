import { Alert, Box, Stack, Text } from '@mantine/core';
import type {
  TranscriptElisionDivider,
  TranscriptTimelineEvent,
} from '@agent-lcars/telemetry';
import { isElisionDivider } from '@agent-lcars/telemetry';

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
          <Text size="xs" c="dimmed" fw={600} tt="uppercase">
            {event.role}
          </Text>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {event.text}
          </Text>
        </Box>
      );

    case 'tool_use':
      return (
        <details>
          <summary style={{ cursor: 'pointer' }}>
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
        <details>
          <summary style={{ cursor: 'pointer' }}>
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
        <details data-testid="transcript-sidechain-group">
          <summary style={{ cursor: 'pointer' }}>
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
 * Renders a parsed+elided transcript timeline (see
 * @agent-lcars/telemetry's transcript-timeline.ts) turn by turn. Server
 * component throughout - the elision itself already happened server-side
 * (session-transcript.ts), so there's no client-side pagination to wire up
 * (see elideTranscriptTimeline's doc comment for why that's deliberate for
 * v1: this is a read-only archive page, not a live feed).
 */
export function TranscriptTimelineView({
  events,
  warning,
}: {
  events: (TranscriptTimelineEvent | TranscriptElisionDivider)[];
  warning?: string;
}) {
  return (
    <Stack gap="xs" data-testid="transcript-timeline">
      {warning && (
        <Text size="xs" c="orange" data-testid="transcript-warning">
          {warning}
        </Text>
      )}
      {events.length === 0 && !warning && (
        <Text size="sm" c="dimmed">
          No transcript events.
        </Text>
      )}
      {events.map((entry, i) =>
        isElisionDivider(entry) ? (
          <Text
            key={`elision-${i}`}
            size="xs"
            c="dimmed"
            ta="center"
            data-testid="transcript-elision"
          >
            … {entry.elidedCount} events elided …
          </Text>
        ) : (
          <TranscriptEventView key={i} event={entry} />
        ),
      )}
    </Stack>
  );
}
