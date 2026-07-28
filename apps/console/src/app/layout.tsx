import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './global.css';

import {
  ColorSchemeScript,
  MantineColorScheme,
  mantineHtmlProps,
} from '@mantine/core';
import { BrowserErrorReporter } from '@repo/app-providers';
import type { Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import { Suspense } from 'react';

import { bodyFont, displayFont, monoFont } from './fonts';
import { Providers } from './providers';

export const viewport: Viewport = {
  // Without this, mobile browsers that don't detect our Mantine-driven dark
  // mode support (it's applied via a CSS custom property, not a literal
  // `dark`/`light` value some browser heuristics look for) can apply their
  // own auto-darkening on top of our own colors, inverting some elements
  // against their non-inverted backgrounds (#2815).
  colorScheme: 'light dark',
};

export const metadata = {
  title: 'Agent LCARS',
  description: 'supersprinklesracing/sprinkles — Claude issue agent activity',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      {...mantineHtmlProps}
      className={`${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`}
    >
      <head>
        {/* Stays outside Suspense and takes the same 'dark' fallback the
            cookie read below defaults to: this script runs before paint, so
            deferring it is what would cause a flash. The cookie-derived
            value still reaches Providers, which is what SSR markup matches
            against. */}
        <ColorSchemeScript defaultColorScheme="dark" />
      </head>
      <body>
        {/* `cacheComponents` requires the cookie/header reads to sit inside
            a boundary. They gate only the shell's own chrome, so this
            streams rather than blocking the document. */}
        <Suspense fallback={null}>
          <DynamicShell>{children}</DynamicShell>
        </Suspense>
      </body>
    </html>
  );
}

async function DynamicShell({ children }: { children: React.ReactNode }) {
  // Sanitize the trace id (strictly hex, 32 chars) to safely embed it client-side.
  const traceId = ((await headers()).get('x-cloud-trace-context') || '')
    .split('/')[0]
    .replace(/[^a-f0-9]/gi, '')
    .substring(0, 32);

  // Read the toggle's cookie so the SSR-rendered page already agrees with
  // the user's last choice instead of flashing the default on every reload.
  const cookieValue = (await cookies()).get('mantine-color-scheme')?.value;
  const colorScheme: MantineColorScheme =
    cookieValue === 'light' || cookieValue === 'dark' || cookieValue === 'auto'
      ? cookieValue
      : 'dark';

  return (
    <>
      <BrowserErrorReporter traceId={traceId} />
      <Providers colorScheme={colorScheme}>{children}</Providers>
    </>
  );
}
