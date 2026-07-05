import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './global.css';

import { ColorSchemeScript, mantineHtmlProps } from '@mantine/core';

import { Providers } from './providers';

export const metadata = {
  title: 'Agent Console',
  description: 'supersprinklesracing/members — Claude issue agent activity',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <ColorSchemeScript defaultColorScheme="dark" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
