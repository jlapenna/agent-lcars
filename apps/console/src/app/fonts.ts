import { Antonio, IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';

// Condensed geometric display face for headings/eyebrows only — the
// LCARS-panel-lettering register. Never used for body copy.
export const displayFont = Antonio({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
});

// Body/UI face. IBM Plex Sans reads as "engineered instrument" rather than
// generic SaaS sans, and shares a designed-together mono sibling below.
export const bodyFont = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-body',
  display: 'swap',
});

// Data face: session/run IDs, takeover commands, transcript dumps, error
// digests — unifies three previously-divergent monospace mechanisms.
export const monoFont = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});
