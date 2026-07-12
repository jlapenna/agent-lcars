const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 60 * 60 * 24 * 365],
  ['month', 60 * 60 * 24 * 30],
  ['week', 60 * 60 * 24 * 7],
  ['day', 60 * 60 * 24],
  ['hour', 60 * 60],
  ['minute', 60],
];

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/**
 * Formatted server-side (see page.tsx) rather than in the 'use client' card
 * component: computing "now" during hydration risks a mismatch with the
 * server-rendered value (see docs/next-auth.md and prior SSR timestamp bugs).
 */
export function formatRelativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  for (const [unit, secondsPerUnit] of UNITS) {
    const value = Math.floor(seconds / secondsPerUnit);
    if (value >= 1) return rtf.format(-value, unit);
  }
  return 'just now';
}

// Parent/linked references are virtually always issues (trackers, "closes
// #N"), so always link to /issues/N rather than trying to guess kind.
export function githubIssueUrl(item: { url: string }, number: number): string {
  return item.url.replace(/\/(?:issues|pull)\/\d+$/, `/issues/${number}`);
}

/** Compact duration for run rows: "42s", "4m 32s", "1h 12m". */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Compact token count for session rows: "842", "12.3k", "1.2M". */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
