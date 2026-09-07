import { Container } from '@mantine/core';
import type { ReactNode } from 'react';

import type { NavAccent, NavKey } from './console-navigation';

/**
 * Common outer frame for every top-level console destination.
 *
 * Carries the route's identity as data attributes so the whole page — not
 * just the header — can resolve one accent. `data-accent` is what the accent
 * table in global.css matches to set the inherited `--lcars-accent`, which
 * the header elbow, the active rail pill, panel spines and the route's
 * buttons all read. Before #1825 each of those picked its own color per
 * route per breakpoint, and they had drifted apart.
 */
export function ConsolePageShell({
  children,
  className,
  route,
  accent,
}: {
  children: ReactNode;
  className?: string;
  route?: NavKey;
  accent?: NavAccent;
}) {
  return (
    <Container
      size="xl"
      py="xl"
      className={['console-page-shell', className].filter(Boolean).join(' ')}
      data-route={route}
      data-accent={accent}
    >
      {children}
    </Container>
  );
}
