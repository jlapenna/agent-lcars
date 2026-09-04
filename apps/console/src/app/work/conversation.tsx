import type { ItemView } from '@agent-lcars/work/derive';
import { Anchor, Code, Group, Stack, Text } from '@mantine/core';

import { safeHttpUrl } from './safe-url';

/** Same rendering rule `page.tsx`'s `RunRef` already uses: `result.ref` is
 *  agent-reported and opaque, so it becomes a link only once `safeHttpUrl`
 *  confirms it is an absolute http(s) URL. */
function TurnRef({ value }: { value: string | undefined }) {
  const href = safeHttpUrl(value);
  if (!href) return null;
  return (
    <Anchor href={href} target="_blank" rel="noreferrer" size="xs">
      ref
    </Anchor>
  );
}

function HumanTurn({
  text,
  principal,
  channel,
}: {
  text: string;
  principal: string;
  channel: string;
}) {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        {principal} via {channel}
      </Text>
      <Code block>{text}</Code>
    </Stack>
  );
}

function AgentTurn({
  message,
  ref,
  sessionId,
}: {
  message: string;
  ref: string | undefined;
  sessionId: string | undefined;
}) {
  return (
    <Stack gap={2} data-testid="agent-turn">
      <Text size="xs" c="dimmed">
        agent
      </Text>
      <Text>{message}</Text>
      <Group gap="xs">
        <TurnRef value={ref} />
        {sessionId !== undefined && (
          <Anchor href={`/sessions/${encodeURIComponent(sessionId)}`} size="xs">
            session
          </Anchor>
        )}
      </Group>
    </Stack>
  );
}

/**
 * The derived conversation view: for each round (`ItemView.runs`, already
 * oldest-first), the human turn that opened it followed by the agent's
 * turn, when it left one. Round 1's human turn is the item's own
 * description, attributed to its origin -- there is no `reply` on the
 * first run, `params.reply` only exists from round 2 on
 * (`libs/work/src/derive.ts`'s `ItemRunView`).
 *
 * Presentational only: no data fetching, no server calls. `item.sessions`
 * is joined by `runId` for the agent turn's session link, same join key
 * `page.tsx`'s existing `SessionsList` uses.
 */
export function Conversation({ item }: { item: ItemView }) {
  return (
    <Stack gap="md">
      {item.runs.map((run, index) => {
        const isFirstRound = index === 0;
        const humanText = isFirstRound ? item.spec.description : run.reply;
        const humanPrincipal = isFirstRound
          ? item.origin.principal
          : (run.replyPrincipal ?? 'unknown');
        const humanChannel = isFirstRound
          ? item.origin.channel
          : (run.replyChannel ?? 'unknown');
        const session = item.sessions.find((s) => s.runId === run.runId);
        return (
          <Stack key={run.runId} gap="xs">
            {humanText !== undefined && (
              <HumanTurn
                text={humanText}
                principal={humanPrincipal}
                channel={humanChannel}
              />
            )}
            {run.result?.message !== undefined && (
              <AgentTurn
                message={run.result.message}
                ref={run.result.ref}
                sessionId={session?.sessionId}
              />
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}
