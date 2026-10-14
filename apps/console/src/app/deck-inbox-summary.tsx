'use client';

import { Anchor, Group, Text } from '@mantine/core';
import Link from 'next/link';

/**
 * The Bridge's one-line answer to "does anything need me?" - the
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
  nativeAvailable = true,
  compact = false,
}: {
  count: number;
  inboxHref: string;
  nativeAvailable?: boolean;
  /** The toolbar's primary action alone, as in the mockup: the count is in
   * its label. Only a degraded native read keeps its note. */
  compact?: boolean;
}) {
  // The Bridge toolbar's primary action, so it wears the Bridge's accent like
  // the mockup's primary button (design/fleet-console.html `.btn-primary`),
  // not the Inbox's it links to (#1815).
  return (
    <Group
      gap="md"
      align="center"
      wrap="wrap"
      className="deck-inbox-summary lcars-panel"
      data-testid="deck-inbox-summary"
      data-empty={count === 0 && nativeAvailable ? '' : undefined}
    >
      {compact ? null : (
        <Text component="span" fw={700} className="deck-inbox-summary__count">
          {count}
        </Text>
      )}
      {compact && nativeAvailable ? null : (
        <Text component="span" fw={600} className="deck-inbox-summary__label">
          {!nativeAvailable
            ? 'GitHub decisions waiting · native unavailable'
            : count === 0
              ? 'No decisions waiting'
              : 'Decisions waiting'}
        </Text>
      )}
      {/* Deliberately avoids the word "Inbox": Playwright role-name
          matching is substring-based, and the e2e suite addresses the nav
          pill with an unscoped getByRole('link', { name: 'Inbox' }) - a
          second link containing that word is a strict-mode violation
          (Codex review on #481). */}
      <Anchor
        component={Link}
        href={inboxHref}
        size="sm"
        fw={700}
        className="deck-inbox-summary__action"
      >
        {!nativeAvailable
          ? 'Review queue'
          : count === 0
            ? compact
              ? 'No decisions waiting'
              : 'Review queue'
            : `Review ${count} decision${count === 1 ? '' : 's'}`}
      </Anchor>
    </Group>
  );
}
