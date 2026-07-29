import { Anchor, Group, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';

type NavKey = 'queue' | 'agents' | 'sessions' | 'costs';
type Accent = 'amber' | 'periwinkle' | 'teal' | 'gold';

const NAV_ITEMS: Array<{
  key: NavKey;
  href: string;
  label: string;
  accent: Accent;
}> = [
  { key: 'queue', href: '/', label: 'Queue', accent: 'amber' },
  { key: 'agents', href: '/agents', label: 'Agents', accent: 'periwinkle' },
  { key: 'sessions', href: '/sessions', label: 'Sessions', accent: 'teal' },
  { key: 'costs', href: '/costs', label: 'Costs', accent: 'gold' },
];

export interface ConsoleHeaderProps {
  current: NavKey;
  title: string;
  subtitle: ReactNode;
  actions?: ReactNode;
}

/**
 * Shared top-of-page chrome for the four console destinations (dashboard,
 * agents, sessions, costs): title/subtitle row and the LCARS pill nav rail
 * (the one page every page can jump from/to). The session detail page (a
 * drill-down, not a nav destination) keeps its own lighter back-link header
 * instead of this component.
 *
 * The title/subtitle row itself carries the swept-corner "elbow" accent
 * (`.lcars-header`, sized up from the same shape `.lcars-panel` uses for
 * cards - see global.css) plus a segmented signal bar in the nav rail's own
 * accent colors, so the marquee page title reads as LCARS chrome rather
 * than a plain heading sitting above the pill rail (#204).
 *
 * Title/subtitle/nav never depend on the slow GitHub/Firestore reads
 * `cacheComponents` requires a Suspense boundary for, so every page renders
 * this outside that boundary and renders `DataWarnings` itself once its data
 * resolves (see those pages' `*PageShell`/body components) - the header
 * then never sits behind the streamed content's placeholder. `sessions`'
 * subtitle needs one fetched value (the row count) that dashboard/agents
 * don't; it wraps just that value in its own inline Suspense rather than
 * passing anything data-dependent through here (see its `SessionCount`).
 */
export function ConsoleHeader({
  current,
  title,
  subtitle,
  actions,
}: ConsoleHeaderProps) {
  return (
    <Stack gap="md" mb="xl">
      <div className="lcars-header">
        <Group justify="space-between" align="flex-start" gap="sm">
          <div>
            <Title order={1} className="lcars-header-title">
              {title}
            </Title>
            <Text c="dimmed" mt={4}>
              {subtitle}
            </Text>
          </div>
          {actions && (
            <Group gap="sm" wrap="wrap">
              {actions}
            </Group>
          )}
        </Group>

        <div className="lcars-header-bar" aria-hidden="true">
          <span className="lcars-header-bar-segment" data-accent="amber" />
          <span className="lcars-header-bar-segment" data-accent="periwinkle" />
          <span className="lcars-header-bar-segment" data-accent="gold" />
          <span className="lcars-header-bar-segment" data-accent="teal" />
        </div>
      </div>

      <nav className="lcars-nav" aria-label="Console sections">
        {NAV_ITEMS.map((item) => (
          <Anchor
            key={item.key}
            href={item.href}
            underline="never"
            className="lcars-nav-pill"
            data-accent={item.accent}
            data-active={item.key === current ? '' : undefined}
            aria-current={item.key === current ? 'page' : undefined}
          >
            {item.label}
          </Anchor>
        ))}
      </nav>
    </Stack>
  );
}

/** The data-warnings disclosure, factored out of `ConsoleHeader` so every
 * page (which all now split their header from their data-dependent body -
 * see `ConsoleHeader`'s doc comment) can render it once its data resolves,
 * directly below the nav rail. */
export function DataWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;

  return (
    <details data-testid="data-warnings">
      <summary style={{ cursor: 'pointer' }}>
        <Text size="sm" c="yellow" component="span">
          ⚠ {warnings.length} data warning{warnings.length === 1 ? '' : 's'} —
          some sections may be incomplete
        </Text>
      </summary>
      <Stack gap={4} mt="xs">
        {warnings.map((warning) => (
          <Text key={warning} size="xs" c="dimmed">
            {warning}
          </Text>
        ))}
      </Stack>
    </details>
  );
}
