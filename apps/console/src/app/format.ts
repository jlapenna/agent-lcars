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

/** Dense queue-row timestamp: "now", "15m ago", "2h ago", "1d ago". */
export function formatCompactRelativeTime(iso: string): string {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (seconds < 60) return 'now';
  const units: [string, number][] = [
    ['y', 60 * 60 * 24 * 365],
    ['mo', 60 * 60 * 24 * 30],
    ['w', 60 * 60 * 24 * 7],
    ['d', 60 * 60 * 24],
    ['h', 60 * 60],
    ['m', 60],
  ];
  for (const [unit, secondsPerUnit] of units) {
    const value = Math.floor(seconds / secondsPerUnit);
    if (value >= 1) return `${value}${unit} ago`;
  }
  return 'now';
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

/** Running cost for the in-flight budget gauge: "$0.42", "$3.10". Floors at
 * $0 - a stored `totalCostUsd` can still be negative for a doc written
 * before reducer.ts started clamping it (see docCost's doc comment in
 * session-ledger.ts), and a negative dollar figure is never meaningful to
 * show here regardless of which upstream value produced it. */
export function formatCost(usd: number): string {
  return `$${Math.max(0, usd).toFixed(2)}`;
}

/* `shareArtifactUrl` moved to lib/deployment.ts: its base URL is
 * deployment config, and reading server-only config from this module would
 * drag @repo/util-server into the client bundles that import it
 * (refresh-button.tsx, action-item-card.tsx). */
