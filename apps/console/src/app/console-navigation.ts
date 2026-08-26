export type NavKey =
  | 'deck'
  | 'inbox'
  | 'agents'
  | 'shuttlebay'
  // 'work' is a valid page-shell `current` value (the /work pages use the
  // same shared header/shell as every other destination) but deliberately
  // has no CONSOLE_DESTINATIONS entry below: v1 keeps it reachable by URL,
  // the API, and the CLI only. A 7th rail item overflows the mobile header
  // (see mobile-header-every-page.spec.ts) - a nav slot is a follow-up once
  // the header layout can take it.
  | 'work'
  | 'sessions'
  | 'costs';
export type NavAccent = 'amber' | 'blue' | 'periwinkle' | 'teal' | 'gold';

/** One registry drives the desktop rail and the mobile overflow menu. */
export const CONSOLE_DESTINATIONS: ReadonlyArray<{
  key: NavKey;
  href: string;
  label: string;
  accent: NavAccent;
}> = [
  { key: 'deck', href: '/', label: 'Bridge', accent: 'amber' },
  { key: 'inbox', href: '/inbox', label: 'Inbox', accent: 'blue' },
  { key: 'agents', href: '/agents', label: 'Agents', accent: 'periwinkle' },
  {
    key: 'shuttlebay',
    href: '/shuttlebay',
    label: 'Shuttlebay',
    accent: 'blue',
  },
  { key: 'sessions', href: '/sessions', label: 'Sessions', accent: 'teal' },
  { key: 'costs', href: '/costs', label: 'Costs', accent: 'gold' },
];
