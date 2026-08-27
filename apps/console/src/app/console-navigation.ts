export type NavKey =
  | 'deck'
  | 'inbox'
  | 'agents'
  | 'shuttlebay'
  // 'work' joined the destinations in sub-project 2; the /work pages set it
  // as current.
  | 'work'
  | 'sessions'
  | 'costs';
export type NavAccent =
  'amber' | 'blue' | 'periwinkle' | 'teal' | 'gold' | 'violet';

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
  { key: 'work', href: '/work', label: 'Work', accent: 'violet' },
  { key: 'sessions', href: '/sessions', label: 'Sessions', accent: 'teal' },
  { key: 'costs', href: '/costs', label: 'Costs', accent: 'gold' },
];
