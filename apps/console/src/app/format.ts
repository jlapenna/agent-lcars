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

/** Viewer-local absolute time for hover titles: "2026-08-03 04:58".
 * Built from Date parts rather than toLocaleString - the lint config pins
 * locale/timezone-defaulting APIs (they cause server/client mismatches),
 * and this numeric layout needs no locale. Only meaningful client-side,
 * where the runtime timezone is the viewer's own. */
export function formatAbsoluteLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Compact duration for run rows: "42s", "4m 32s", "1h 12m". */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Fixed `en-US` rather than the ambient locale: this renders on the server
 * and again on the client during hydration, and a server whose ICU default
 * differs from the browser's would produce two different strings for the
 * same number and trip a hydration mismatch. The console is single-locale
 * anyway. */
const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

/** Costs anywhere they're shown - the in-flight budget gauge, the session
 * table, the cost ledger: "$0.42", "$3.10", "$3,953.71". Grouped, because
 * the ledger's whole-window totals reach four and five figures and an
 * ungrouped "$3953.71" is genuinely harder to read at a glance (#213) -
 * matching the token columns beside it, which have always been grouped.
 *
 * Floors at $0 - a stored `totalCostUsd` can still be negative for a doc
 * written before reducer.ts started clamping it (see docCost's doc comment
 * in session-ledger.ts), and a negative dollar figure is never meaningful to
 * show here regardless of which upstream value produced it. */
export function formatCost(usd: number): string {
  return USD.format(Math.max(0, usd));
}

/* `shareArtifactUrl` moved to lib/deployment.ts: its base URL is
 * deployment config, and reading server-only config from this module would
 * drag @repo/util-server into the client bundles that import it
 * (refresh-button.tsx, action-item-card.tsx). */
