import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './global.css';

import {
  ColorSchemeScript,
  MantineColorScheme,
  mantineHtmlProps,
} from '@mantine/core';
import { BrowserErrorReporter } from '@repo/app-providers';
import { cookies, headers } from 'next/headers';

import { Providers } from './providers';

export const metadata = {
  title: 'Agent Console',
  description: 'supersprinklesracing/members — Claude issue agent activity',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Sanitize the trace id (strictly hex, 32 chars) to safely embed it client-side.
  const traceId = ((await headers()).get('x-cloud-trace-context') || '')
    .split('/')[0]
    .replace(/[^a-f0-9]/gi, '')
    .substring(0, 32);

  // Mirrors apps/members/frontend/src/app/layout.tsx: read the toggle's
  // cookie so the SSR-rendered page and ColorSchemeScript already agree with
  // the user's last choice instead of flashing the default on every reload.
  const cookieValue = (await cookies()).get('mantine-color-scheme')?.value;
  const colorScheme: MantineColorScheme =
    cookieValue === 'light' || cookieValue === 'dark' || cookieValue === 'auto'
      ? cookieValue
      : 'dark';

  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <ColorSchemeScript defaultColorScheme={colorScheme} />
      </head>
      <body>
        <BrowserErrorReporter traceId={traceId} />
        <Providers colorScheme={colorScheme}>{children}</Providers>
      </body>
    </html>
  );
}
