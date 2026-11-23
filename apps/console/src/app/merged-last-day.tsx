import { mergedLastDay } from '../lib/merged-pulls';
import { NavSuspense } from './nav-suspense';
import { UNAVAILABLE } from './ops-primitives';

async function MergedLastDayCount({ repo }: { repo?: string }) {
  const count = await mergedLastDay(repo);
  return count === undefined
    ? `${UNAVAILABLE} merged · 24h`
    : `${count.count}${count.partial ? '+' : ''} merged · 24h`;
}

/**
 * Recent completions' head in design/fleet-console.html: pull requests merged
 * in the last day, counted from GitHub in the page's repository scope. It
 * streams in after the page, so a cold GitHub count never holds the panels.
 */
export function MergedLastDay({ repo }: { repo?: string }) {
  return (
    <NavSuspense fallback={`${UNAVAILABLE} merged · 24h`}>
      <MergedLastDayCount repo={repo} />
    </NavSuspense>
  );
}
