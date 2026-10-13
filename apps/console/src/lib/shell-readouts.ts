import { isE2eTesting } from '@agent-lcars/util-server';
import { cacheLife } from 'next/cache';

import { context as workContext } from '../app/work/context';
import { auth } from '../auth';
import { DASHBOARD_CACHE_LIFE, getCachedAgentActivity } from './dashboard-data';
import { consoleUrl } from './deployment';
import { loadInboxNotificationSnapshot } from './inbox-notifications-data';
import { getSessionArchive } from './session-archive';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The figures the console frame shows on every page: the rail readouts, the
 * destination counts and the signed-in identity. A field is absent when its
 * source could not be read, which the frame renders as unavailable, never as
 * a zero.
 */
export interface ShellReadouts {
  user: { login: string; initials: string; grants: string[] };
  /** Host the console is served from, the rail's environment line. */
  environment: string;
  /** Present for maintainers only. */
  fleet?: { online?: number; capacity?: number };
  /** Admitted runs not yet running (queued + claimed). */
  queueDepth?: number;
  liveRuns?: number;
  decisions?: number;
  tokens24h?: number;
  /** Lifetime tokens of sessions active in the last 24h. Partial when the
   * archive hit its session cap: a lower bound. */
  tokens24hPartial?: boolean;
  merged24h?: number;
  /** Capped sessions or unknown merge evidence: a lower bound. */
  merged24hPartial?: boolean;
  observedAt: string;
}

interface RecentSpend {
  tokens24h?: number;
  tokens24hPartial?: boolean;
  merged24h?: number;
  merged24hPartial?: boolean;
}

const STORE_FAILED = 'Session archive unavailable';

/** Throws when either archive read failed, so a failure is never cached as
 * a zero; the caller then reports both figures unavailable. */
async function readRecentSpend(): Promise<RecentSpend> {
  const now = Date.now();
  // Merges are attributed through session deliverables, so read a week of
  // sessions and count the PRs whose recorded merge falls in the last day.
  const [day, week] = await Promise.all([
    getSessionArchive({ days: 1 }, { includeSpend: true }),
    getSessionArchive({ days: 7 }, { includeSpend: true }),
  ]);
  const failed = (warnings: string[]) =>
    warnings.some((warning) => warning.startsWith(STORE_FAILED));
  if (
    !day.spend ||
    !week.spend ||
    failed(day.warnings) ||
    failed(week.warnings)
  )
    throw new Error('Session archive unavailable');
  return {
    tokens24h: day.spend.totals.tokens,
    // The archive hit its session cap: more sessions exist than were summed.
    tokens24hPartial: day.spend.coverageLimited,
    merged24h: week.spend.deliverables.filter(
      (deliverable) =>
        deliverable.mergedAt !== undefined &&
        now - Date.parse(deliverable.mergedAt) <= DAY_MS,
    ).length,
    // Capped sessions or missing merge evidence can hide merges.
    merged24hPartial:
      week.spend.coverageLimited ||
      week.spend.deliverables.some(
        (deliverable) => deliverable.status === 'unknown',
      ),
  };
}

async function readCachedRecentSpend(): Promise<RecentSpend> {
  'use cache';
  cacheLife(DASHBOARD_CACHE_LIFE);
  return readRecentSpend();
}

function initialsOf(login: string): string {
  const [first = '', second = ''] = login.split(/[^a-z0-9]+/i).filter(Boolean);
  const letters = second ? `${first.charAt(0)}${second.charAt(0)}` : login;
  return letters.slice(0, 2).toUpperCase();
}

function environmentLabel(): string {
  try {
    return new URL(consoleUrl()).host;
  } catch {
    return '';
  }
}

export async function loadShellReadouts(): Promise<ShellReadouts | undefined> {
  const session = await auth();
  if (!session?.user) return undefined;
  const login = session.user.login ?? session.user.name ?? '';
  const grants = await workContext()
    .then((ctx) => [...(ctx.principal?.scopes ?? [])].sort())
    .catch(() => [] as string[]);
  const base: ShellReadouts = {
    user: {
      login,
      initials: initialsOf(login || '?'),
      grants: [...(session.user.isAdmin ? ['admin'] : []), ...grants],
    },
    environment: environmentLabel(),
    observedAt: new Date().toISOString(),
  };
  if (!session.user.isAdmin) return base;

  const [activity, snapshot, spend] = await Promise.all([
    getCachedAgentActivity().catch(() => undefined),
    loadInboxNotificationSnapshot().catch(() => undefined),
    (isE2eTesting() ? readRecentSpend() : readCachedRecentSpend()).catch(
      () => ({}) as RecentSpend,
    ),
  ]);
  const queue = activity?.data.queue;
  const fleet = activity?.data.fleet;
  return {
    ...base,
    ...(fleet?.online !== undefined
      ? { fleet: { online: fleet.online, capacity: fleet.capacity } }
      : {}),
    ...(activity && queue
      ? {
          queueDepth: queue.queued + queue.claimed,
          liveRuns: activity.data.liveRuns.length,
        }
      : {}),
    ...(snapshot ? { decisions: snapshot.decisions.length } : {}),
    ...spend,
  };
}
