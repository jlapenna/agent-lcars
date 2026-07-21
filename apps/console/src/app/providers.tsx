'use client';

import { MantineColorScheme } from '@mantine/core';
import { AppProviders } from '@repo/app-providers';

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
