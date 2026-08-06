'use client';

import { AppProviders } from '@agent-lcars/app-providers';
import { MantineColorScheme } from '@mantine/core';

import { theme } from './theme';

export function Providers({
  children,
  colorScheme,
}: {
  children: React.ReactNode;
  colorScheme: MantineColorScheme;
}) {
  return (
    <AppProviders theme={theme} colorScheme={colorScheme}>
      {children}
    </AppProviders>
  );
}
