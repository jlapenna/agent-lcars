import { Container } from '@mantine/core';
import type { ReactNode } from 'react';

/** Common outer frame for every top-level console destination. */
export function ConsolePageShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Container
      size="xl"
      py="xl"
      className={['console-page-shell', className].filter(Boolean).join(' ')}
    >
      {children}
    </Container>
  );
}
