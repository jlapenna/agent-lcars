'use client';

import { Anchor } from '@mantine/core';
import Link from 'next/link';

/**
 * Client half of the Flat / By-issue archive toggle: the links render
 * through next/link, and a component reference can't cross the
 * server->client boundary as a prop, so the boundary sits here. The
 * server page keeps `displayHref` and passes the two computed hrefs down
 * as plain strings.
 */
export function ViewToggle({
  view,
  flatHref,
  byIssueHref,
}: {
  view: 'flat' | 'by-issue';
  flatHref: string;
  byIssueHref: string;
}) {
  const options = [
    { key: 'flat' as const, href: flatHref, label: 'Flat' },
    { key: 'by-issue' as const, href: byIssueHref, label: 'By issue' },
  ];
  return (
    <nav className="sessions-view-toggle" aria-label="Archive view">
      {options.map((option) => (
        <Anchor
          key={option.key}
          component={Link}
          href={option.href}
          className="sessions-view-toggle__option"
          data-active={option.key === view ? '' : undefined}
          aria-current={option.key === view ? 'page' : undefined}
          underline="never"
        >
          {option.label}
        </Anchor>
      ))}
    </nav>
  );
}
