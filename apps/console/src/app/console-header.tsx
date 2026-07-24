import { Anchor, Group, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';

import { RefreshButton } from './refresh-button';
import { ThemeToggle } from './theme-toggle';

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
  generatedAt: string;
  refreshLabel: string;
  warnings?: string[];
}

/**
 * Shared top-of-page chrome for the three console destinations (dashboard,
 * agents, sessions): title/subtitle row, the LCARS pill nav rail (the one
 * page every page can jump from/to), and the optional data-warnings
 * disclosure. The session detail page (a drill-down, not a nav destination)
 * keeps its own lighter back-link header instead of this component.
 */
export function ConsoleHeader({
  current,
  title,
  subtitle,
  actions,
  generatedAt,
  refreshLabel,
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
        <Group gap="sm" wrap="wrap">
          {actions}
          <RefreshButton
            generatedAt={generatedAt}
            initialLabel={refreshLabel}
          />
          <ThemeToggle size="lg" />
        </Group>
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

      {warnings && warnings.length > 0 && (
        <details data-testid="data-warnings">
          <summary style={{ cursor: 'pointer' }}>
            <Text size="sm" c="yellow" component="span">
              ⚠ {warnings.length} data warning
              {warnings.length === 1 ? '' : 's'} — some sections may be
              incomplete
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
      )}
    </Stack>
  );
}
