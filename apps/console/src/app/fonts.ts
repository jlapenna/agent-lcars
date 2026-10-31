import localFont from 'next/font/local';
import type { CSSProperties } from 'react';

import { fontStack } from './font-stack';

// These are vendored copies of the Latin subsets previously fetched by
// next/font/google, split by `fontTools.subset` into a core file (printable
// ASCII plus the punctuation the console draws: nbsp, ·, ×, – —, ‘ ’ “ ”, •,
// …, arrows, −) and an extended file holding every other glyph of the same
// subset. Each face's `unicode-range` names exactly its file's glyphs, so a
// page downloads the extended file only when it renders one of them; the faces
// themselves are unchanged. Keeping the extended glyphs out of the cold path
// saves ~33 KB of the phone Inbox's bandwidth-bound load (#2201).
//
// Each family is core first, then extended, then the core face's
// metric-adjusted fallback (next/font sizes it from a-z, which only the core
// file has): a glyph outside the core range falls through to the real
// extended face rather than to the system fallback.

// next/font accepts only literal options, so every core face and every
// extended face repeats the same range string.

// Condensed geometric display face for headings/eyebrows only — the
// LCARS-panel-lettering register. Never used for body copy.
const displayCore = localFont({
  src: '../../public/fonts/Antonio-500-700-core.woff2',
  weight: '500 700',
  style: 'normal',
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0020-007E,U+00A0,U+00B7,U+00D7,U+2013-2014,U+2018-2019,U+201C-201D,U+2022,U+2026,U+2190-2193,U+2197,U+2212',
    },
  ],
  // Keep cold-route bandwidth available for body text and action hydration.
  // Headings retain the same swap-loaded local face without an eager preload.
  preload: false,
  display: 'swap',
});
const displayExt = localFont({
  src: '../../public/fonts/Antonio-500-700-ext.woff2',
  weight: '500 700',
  style: 'normal',
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+00A1-00B6,U+00B8-00D6,U+00D8-00FF,U+0102,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+2002,U+2009,U+200B,U+201A,U+201E,U+2032-2033,U+2039-203A,U+2044,U+20AC,U+2122,U+2215,U+FEFF,U+FFFD',
    },
  ],
  preload: false,
  adjustFontFallback: false,
  display: 'swap',
});

// Body/UI face. IBM Plex Sans reads as "engineered instrument" rather than
// generic SaaS sans, and shares a designed-together mono sibling below.
const bodyCore = localFont({
  src: '../../public/fonts/IBMPlexSans-400-600-core.woff2',
  weight: '400 600',
  style: 'normal',
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0020-007E,U+00A0,U+00B7,U+00D7,U+2013-2014,U+2018-2019,U+201C-201D,U+2022,U+2026,U+2190-2193,U+2197,U+2212',
    },
  ],
  display: 'swap',
});
const bodyExt = localFont({
  src: '../../public/fonts/IBMPlexSans-400-600-ext.woff2',
  weight: '400 600',
  style: 'normal',
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+00A1-00B6,U+00B8-00D6,U+00D8-00FF,U+0102,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+2002,U+2009,U+200B,U+201A,U+201E,U+2032-2033,U+2039-203A,U+2044,U+20AC,U+2122,U+2215,U+FEFF,U+FFFD',
    },
  ],
  preload: false,
  adjustFontFallback: false,
  display: 'swap',
});

// Data face: session/run IDs, takeover commands, transcript dumps, error
// digests — unifies three previously-divergent monospace mechanisms.
// Request each data weight when used rather than preloading both on every route.
const monoCore = localFont({
  src: [
    {
      path: '../../public/fonts/IBMPlexMono-400-core.woff2',
      weight: '400',
      style: 'normal',
    },
    {
      path: '../../public/fonts/IBMPlexMono-500-core.woff2',
      weight: '500',
      style: 'normal',
    },
  ],
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0020-007E,U+00A0,U+00B7,U+00D7,U+2013-2014,U+2018-2019,U+201C-201D,U+2022,U+2026,U+2190-2193,U+2197,U+2212',
    },
  ],
  preload: false,
  display: 'swap',
});
const monoExt = localFont({
  src: [
    {
      path: '../../public/fonts/IBMPlexMono-400-ext.woff2',
      weight: '400',
      style: 'normal',
    },
    {
      path: '../../public/fonts/IBMPlexMono-500-ext.woff2',
      weight: '500',
      style: 'normal',
    },
  ],
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+00A1-00B6,U+00B8-00D6,U+00D8-00FF,U+0102,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+2002,U+2009,U+200B,U+201A,U+201E,U+2032-2033,U+2039-203A,U+2044,U+20AC,U+2122,U+2215,U+FEFF,U+FFFD',
    },
  ],
  preload: false,
  adjustFontFallback: false,
  display: 'swap',
});

/** Root CSS variables consumed by theme.ts and global.css. */
export const fontVariables = {
  '--font-display': fontStack(displayCore, displayExt),
  '--font-body': fontStack(bodyCore, bodyExt),
  '--font-mono': fontStack(monoCore, monoExt),
} as CSSProperties;
