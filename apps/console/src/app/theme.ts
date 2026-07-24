import { createTheme } from '@mantine/core';

// LCARS-derived design tokens. Overrides Mantine's built-in color slots in
// place (red/orange/yellow/green/blue/teal/violet/grape/gray/dark) rather
// than introducing new color keys, so every existing `color="orange"` /
// `c="dimmed"` / etc. call site across the app repaints automatically with
// no prop renames. See ACTION_COLORS/STATUS_COLORS/PIPELINE_COLORS/etc. in
// agent-activity-panel.tsx and action-item-card.tsx for how these slots map
// to run/session/action semantics.
//
// Named anchors (the hex a person would point to as "the palette"):
//   terracotta #D9694F (red)      — failed/error
//   amber      #FF9F45 (orange)   — primary/signature, silent-error
//   mustard    #E0B84B (yellow)   — caution/timeout
//   jade       #4FAE8C (green)    — success
//   periwinkle-blue   #6C8FE0 (blue)   — running/info categorical
//   icy-teal   #4FB8C4 (teal)     — codex categorical
//   periwinkle-purple #8C8FDE (violet) — opencode/agent categorical
//   magenta    #B15FC7 (grape)    — review-requested/antigravity
//   steel      (gray ramp)        — light-mode surfaces/borders/dimmed text
//   void       (dark ramp)        — dark-mode surfaces/borders/dimmed text
export const theme = createTheme({
  primaryColor: 'orange',
  white: '#f4f4f6',
  black: '#101318',

  fontFamily: 'var(--font-body), sans-serif',
  fontFamilyMonospace: 'var(--font-mono), monospace',
  headings: {
    fontFamily: 'var(--font-display), sans-serif',
    fontWeight: '600',
  },

  colors: {
    red: [
      '#f7efed',
      '#f0dfdb',
      '#e7bfb6',
      '#df9786',
      '#d9694f',
      '#d14828',
      '#b13b20',
      '#91321c',
      '#712918',
      '#4d1e14',
    ],
    orange: [
      '#fcf7f3',
      '#f9ede1',
      '#f6d5b6',
      '#f8b87c',
      '#ff9f45',
      '#ff800a',
      '#e06c00',
      '#bc5b00',
      '#994a00',
      '#6b3604',
    ],
    yellow: [
      '#f8f5ee',
      '#f2ebdb',
      '#eadbb5',
      '#e3c983',
      '#e0b84b',
      '#dba920',
      '#b98e19',
      '#987517',
      '#775c14',
      '#514011',
    ],
    green: [
      '#f2f6f5',
      '#e2ede9',
      '#c4ded4',
      '#9dccbb',
      '#74bda3',
      '#4fae8c',
      '#419476',
      '#377a62',
      '#2e604e',
      '#224337',
    ],
    blue: [
      '#f5f6fa',
      '#e9edf6',
      '#c5d0ec',
      '#95ade3',
      '#6c8fe0',
      '#3466d9',
      '#2252c3',
      '#1e46a2',
      '#1b3a82',
      '#172c5d',
    ],
    teal: [
      '#f5f9f9',
      '#e8f2f3',
      '#c8e2e6',
      '#9dd2d8',
      '#71c3cc',
      '#4fb8c4',
      '#379eaa',
      '#30848e',
      '#286a71',
      '#204c51',
    ],
    violet: [
      '#f1f2f8',
      '#dfe0f1',
      '#bbbde7',
      '#8c8fde',
      '#5a5fd8',
      '#2d33d2',
      '#2429b2',
      '#202493',
      '#1b1f73',
      '#161850',
    ],
    grape: [
      '#f4eef5',
      '#e9dded',
      '#d8bbe0',
      '#c590d3',
      '#b15fc7',
      '#a03dbb',
      '#87329e',
      '#6f2a81',
      '#572365',
      '#3c1b45',
    ],
    gray: [
      '#eeeff2',
      '#dfe2e7',
      '#c5cad3',
      '#a1aaba',
      '#7d8aa1',
      '#66758f',
      '#60708a',
      '#4b576c',
      '#373f4e',
      '#242a32',
    ],
    dark: [
      '#eeeff2',
      '#d0d3dd',
      '#a5adc0',
      '#7582a3',
      '#505c7c',
      '#353e55',
      '#212736',
      '#0c0e13',
      '#08090c',
      '#060709',
    ],
  },

  components: {
    Badge: {
      defaultProps: { radius: 'xl' },
    },
    Card: {
      defaultProps: { radius: 'lg' },
    },
  },
});
