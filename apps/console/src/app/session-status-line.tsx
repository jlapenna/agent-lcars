import type { SessionLiveness } from '@agent-lcars/telemetry';
import { Group, Text } from '@mantine/core';

import { RelativeTime } from './relative-time';

/**
 * The agent-declared "what it's doing right now" line, rendered directly
 * under a session's title wherever one is surfaced - the archive table
 * (session-table.tsx), the dashboard's In Flight panel and the /agents
 * Active Agents section (both via CliSessionRow in agent-activity-panel.tsx)
 * - see issue #1257. A single shared component rather than duplicated per
 * surface: the hidden-when-ended rule and the long-status-degrades-
 * gracefully truncation only need to be gotten right once, and every
 * surface picking it up automatically stays in sync with each other.
 *
 * `statusUpdatedAt` - never `lastActivityAt` - drives the age. The two can
 * diverge on purpose: a session can keep chattering (bumping
 * `lastActivityAt`) long after the thing it declared itself doing has gone
 * stale, and *that* staleness is exactly the signal this line exists to
 * carry - a status frozen for 40 minutes next to an otherwise-live session
 * reads as "this agent is hung on X", which `lastActivityAt` alone can't
 * say. See #1257's design doc: "a stale status renders as visibly stale
 * rather than being suppressed."
 *
 * Hidden entirely once `liveness` is 'ended' - "what it's doing now" is
 * meaningless when it is not doing anything - and hidden when there is no
 * declared status at all, which is the overwhelming common case (this is an
 * opt-in channel an agent has to declare into, not something derived).
 */
export function SessionStatusLine({
  status,
  statusUpdatedAt,
  liveness,
}: {
  status?: string;
  statusUpdatedAt?: string;
  liveness: SessionLiveness;
}) {
  if (!status || liveness === 'ended') {
    return null;
  }

  return (
    <Group
      gap={4}
      wrap="nowrap"
      data-testid="session-status-line"
      style={{ minWidth: 0 }}
    >
      <Text size="xs" c="dimmed" style={{ flexShrink: 0 }} aria-hidden>
        ↳
      </Text>
      {/* `truncate` needs an explicit min-width:0 to actually ellipsize
       * inside a flex row (Group) - a flex child's default min-width is
       * `auto`, which otherwise lets the row overflow instead of clipping
       * - matching how the title anchor beside this line truncates in
       * session-table.tsx. A status is user-declared free text with no
       * upstream length cap the console can rely on, so this has to hold
       * for any length rather than just the common case. */}
      <Text size="xs" c="dimmed" truncate style={{ minWidth: 0 }}>
        {status}
      </Text>
      {statusUpdatedAt && (
        <Text
          size="xs"
          c="dimmed"
          style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
        >
          · <RelativeTime iso={statusUpdatedAt} variant="compact" />
        </Text>
      )}
    </Group>
  );
}
