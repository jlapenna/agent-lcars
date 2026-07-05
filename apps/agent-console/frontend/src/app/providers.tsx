'use client';

import { AppProviders } from '@repo/app-providers';

import { theme } from './theme';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AppProviders theme={theme} colorScheme="dark">
      {children}
    </AppProviders>
  );
}
