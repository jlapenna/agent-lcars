'use client';

import {
  getDefaultZIndex,
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

// Mantine's own Notifications default (`getDefaultZIndex('overlay')`, 400)
// sits above the modal tier (200), so a toast still showing when a dialog
// opens - e.g. filing a Quick Task and reopening the modal before the 4s
// autoClose - renders on top of that dialog and can intercept clicks meant
// for it (agent-lcars#266). Pinning it just under the modal tier keeps
// toasts visible over ordinary page content (still a positive z-index,
// portalled last) without ever covering an open dialog's controls.
const NOTIFICATIONS_Z_INDEX = getDefaultZIndex('modal') - 1;

export function AppProviders({
  children,
  theme,
  colorScheme = 'dark',
}: AppProvidersProps) {
  return (
    <MantineProvider theme={theme} defaultColorScheme={colorScheme}>
      <Notifications zIndex={NOTIFICATIONS_Z_INDEX} />
      <ModalsProvider>{children}</ModalsProvider>
    </MantineProvider>
  );
}
