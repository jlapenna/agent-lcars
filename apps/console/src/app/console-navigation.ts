export type NavKey = 'deck' | 'inbox' | 'agents' | 'sessions' | 'costs';
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
  { key: 'sessions', href: '/sessions', label: 'Sessions', accent: 'teal' },
  { key: 'costs', href: '/costs', label: 'Costs', accent: 'gold' },
];
