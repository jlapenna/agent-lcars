'use client';

import {
  MantineColorScheme,
  MantineProvider,
  MantineThemeOverride,
} from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import React from 'react';

export interface AppProvidersProps {
  children: React.ReactNode;
  theme: MantineThemeOverride;
  colorScheme?: MantineColorScheme;
}

export function AppProviders({
  children,
  theme,
  colorScheme = 'light',
}: AppProvidersProps) {
  return (
    <MantineProvider theme={theme} defaultColorScheme={colorScheme}>
      <Notifications />
      <ModalsProvider>{children}</ModalsProvider>
    </MantineProvider>
  );
}

export default AppProviders;
