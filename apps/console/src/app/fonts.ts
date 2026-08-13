import localFont from 'next/font/local';

// These are vendored copies of the Latin subsets previously fetched by
// next/font/google. Keeping them in-repo makes production builds independent
// of fonts.gstatic.com without changing the rendered faces.

// Condensed geometric display face for headings/eyebrows only — the
// LCARS-panel-lettering register. Never used for body copy.
export const displayFont = localFont({
  src: '../../public/fonts/Antonio-500-700.woff2',
  weight: '500 700',
  style: 'normal',
  variable: '--font-display',
  display: 'swap',
});

// Body/UI face. IBM Plex Sans reads as "engineered instrument" rather than
// generic SaaS sans, and shares a designed-together mono sibling below.
export const bodyFont = localFont({
  src: '../../public/fonts/IBMPlexSans-400-600.woff2',
  weight: '400 600',
  style: 'normal',
  variable: '--font-body',
  display: 'swap',
});

// Data face: session/run IDs, takeover commands, transcript dumps, error
// digests — unifies three previously-divergent monospace mechanisms.
export const monoFont = localFont({
  src: [
    {
      path: '../../public/fonts/IBMPlexMono-400.woff2',
      weight: '400',
      style: 'normal',
    },
    {
      path: '../../public/fonts/IBMPlexMono-500.woff2',
      weight: '500',
      style: 'normal',
    },
  ],
  variable: '--font-mono',
  display: 'swap',
});
