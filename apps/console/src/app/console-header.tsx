import { Anchor, Group, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';

type NavKey = 'queue' | 'agents' | 'sessions';
type Accent = 'amber' | 'periwinkle' | 'teal';

const NAV_ITEMS: Array<{
  key: NavKey;
  href: string;
  label: string;
  accent: Accent;
}> = [
  { key: 'queue', href: '/', label: 'Queue', accent: 'amber' },
  { key: 'agents', href: '/agents', label: 'Agents', accent: 'periwinkle' },
  { key: 'sessions', href: '/sessions', label: 'Sessions', accent: 'teal' },
];

export interface ConsoleHeaderProps {
  current: NavKey;
  title: string;
  subtitle: ReactNode;
  actions?: ReactNode;
  warnings?: string[];
}

/**
 * Shared top-of-page chrome for the three console destinations (dashboard,
 * agents, sessions): title/subtitle row, the LCARS pill nav rail (the one
 * page every page can jump from/to), and the optional data-warnings
 * disclosure. The session detail page (a drill-down, not a nav destination)
 * keeps its own lighter back-link header instead of this component.
 *
 * Title/subtitle/nav never depend on the slow GitHub/Firestore reads
 * `cacheComponents` requires a Suspense boundary for, so a page whose
 * subtitle is likewise data-free (dashboard, agents) can render this outside
 * that boundary and skip `warnings` here, rendering `DataWarnings` itself
 * once the data resolves (see those pages' `*PageShell` components) - the
 * header then never sits behind the streamed content's placeholder. A page
 * whose subtitle genuinely needs the fetched data (sessions) has no such
 * option and passes `warnings` straight through as before.
 */
export function ConsoleHeader({
  current,
  title,
  subtitle,
  actions,
  warnings,
}: ConsoleHeaderProps) {
  return (
    <Stack gap="md" mb="xl">
      <Group justify="space-between" align="flex-start" gap="sm">
        <div>
          <Title order={1}>{title}</Title>
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

      {warnings && <DataWarnings warnings={warnings} />}
    </Stack>
  );
}

/** The data-warnings disclosure `ConsoleHeader` renders inline, factored out
 * so a page that splits its header from its data-dependent body (see
 * `ConsoleHeader`'s doc comment) can render it once the data resolves,
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
