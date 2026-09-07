import { Card, Stack, Title } from '@mantine/core';
import type { ReactNode } from 'react';

/** Shared second-level panel hierarchy for the agent operations workspace. */
export function AgentOperationsPanel({
  title,
  children,
  className,
  testId,
  separated = false,
}: {
  title: ReactNode;
  children: ReactNode;
  className: string;
  testId: string;
  /** Adds the standard gap before the next operational panel. */
  separated?: boolean;
}) {
  return (
    <Card
      withBorder
      radius="md"
      padding="md"
      mb={separated ? 'xl' : undefined}
      data-testid={testId}
      className={`lcars-panel agents-panel ${className}`}
    >
      <Stack gap="sm">
        <Title order={2} size="h4">
          {title}
        </Title>
        {children}
      </Stack>
    </Card>
  );
}
