'use client';

import { Anchor, Group, Text } from '@mantine/core';
import Link from 'next/link';

/**
 * The Command Deck's one-line answer to "does anything need me?" - the
 * Deck already computes `queueView.yourQueue` for its joins but never
 * rendered it, so the only way to learn the Inbox had work was to leave
 * the Deck. Deliberately a plain landmark-free Group (no `role="alert"`,
 * no region name): the e2e suite pins "no Decision Inbox region on the
 * Deck", and this is a signpost, not the inbox itself.
 *
 * 'use client': the Anchor below renders through next/link via Mantine's
 * `component` prop, and a component reference can't cross the
 * server->client boundary as a prop (mirrors sessions/view-toggle.tsx's
 * identical fix) - the server page keeps `inboxHref` as a plain string.
 */
export function DeckInboxSummary({
  count,
  inboxHref,
}: {
  count: number;
  inboxHref: string;
}) {
  return (
    <Group
      gap="xs"
      align="baseline"
      wrap="nowrap"
      className="deck-inbox-summary"
      data-testid="deck-inbox-summary"
      data-empty={count === 0 ? '' : undefined}
    >
      <Text component="span" fw={700} size="lg" ff="monospace">
        {count.toString().padStart(2, '0')}
      </Text>
      <Text component="span" size="sm" style={{ flex: 1, minWidth: 0 }}>
        {count === 0
          ? 'decisions waiting — the Inbox is clear'
          : count === 1
            ? 'item needs your decision'
            : 'items need your decision'}
      </Text>
      {/* Deliberately avoids the word "Inbox": Playwright role-name
          matching is substring-based, and the e2e suite addresses the nav
          pill with an unscoped getByRole('link', { name: 'Inbox' }) - a
          second link containing that word is a strict-mode violation
          (Codex review on #481). */}
      <Anchor
        component={Link}
        href={inboxHref}
        size="sm"
        fw={600}
        style={{ flexShrink: 0 }}
      >
        Open the queue →
      </Anchor>
    </Group>
  );
}
