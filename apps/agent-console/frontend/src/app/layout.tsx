import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './global.css';

import { ColorSchemeScript, mantineHtmlProps } from '@mantine/core';
import { BrowserErrorReporter } from '@repo/app-providers';
import { headers } from 'next/headers';

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

  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <ColorSchemeScript defaultColorScheme="dark" />
      </head>
      <body>
        <BrowserErrorReporter traceId={traceId} />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
