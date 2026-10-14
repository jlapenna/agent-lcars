import { isE2eTesting } from '@agent-lcars/util-server';
import { cacheLife } from 'next/cache';

import { context as workContext } from '../app/work/context';
import { auth } from '../auth';
import { DASHBOARD_CACHE_LIFE, getCachedAgentActivity } from './dashboard-data';
import { consoleUrl } from './deployment';
import { loadInboxNotificationSnapshot } from './inbox-notifications-data';
import { countMergedPullsSince } from './merged-pulls';
import { getSessionArchive } from './session-archive';

const DAY_MS = 24 * 60 * 60 * 1000;
/** GitHub reads may run 15s; the readouts route gives up at 8s. A slow merge
 * count must cost only its own figure, not every readout. */
const MERGES_DEADLINE_MS = 5_000;
/** A day's merge count does not need the dashboard's 30s freshness. The
 * dashboard's 60s expiry left each instance refilling cold, a fill that
 * mints a token per repository and outlasts the deadline, so most page
 * loads showed the figure unavailable. Refresh in the background every five
 * minutes; refill cold only after an hour without readers. */
const MERGES_CACHE_LIFE = { stale: 300, revalidate: 300, expire: 3600 };

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
  /** Present for maintainers only. Absent figures read as unavailable. */
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
  /** An unreadable repository or a full page of merges: a lower bound. */
  merged24hPartial?: boolean;
  observedAt: string;
}

interface RecentTokens {
  tokens24h?: number;
  tokens24hPartial?: boolean;
}

interface RecentMerges {
  merged24h?: number;
  merged24hPartial?: boolean;
}

const STORE_FAILED = 'Session archive unavailable';

/** Throws when the archive read failed, so a failure is never cached as a
 * zero; the caller then reports the figure unavailable. */
async function readRecentTokens(): Promise<RecentTokens> {
  const day = await getSessionArchive({ days: 1 }, { includeSpend: true });
  if (
    !day.spend ||
    day.warnings.some((warning) => warning.startsWith(STORE_FAILED))
  )
    throw new Error('Session archive unavailable');
  return {
    tokens24h: day.spend.totals.tokens,
    // The archive hit its session cap: more sessions exist than were summed.
    tokens24hPartial: day.spend.coverageLimited,
  };
}

/** Counted from GitHub across the watched repositories, so merges no
 * recorded session referenced still count. Throws when nothing could be
 * read, so a failure is never cached as zero merges. */
async function readRecentMerges(): Promise<RecentMerges> {
  const { count, partial } = await countMergedPullsSince(Date.now() - DAY_MS);
  return { merged24h: count, merged24hPartial: partial };
}

async function readCachedRecentTokens(): Promise<RecentTokens> {
  'use cache';
  cacheLife(DASHBOARD_CACHE_LIFE);
  return readRecentTokens();
}

async function readCachedRecentMerges(): Promise<RecentMerges> {
  'use cache';
  cacheLife(MERGES_CACHE_LIFE);
  return readRecentMerges();
}

async function withinDeadline<T>(read: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Read timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

  const [activity, snapshot, tokens, merges] = await Promise.all([
    getCachedAgentActivity().catch(() => undefined),
    loadInboxNotificationSnapshot().catch(() => undefined),
    (isE2eTesting() ? readRecentTokens() : readCachedRecentTokens()).catch(
      () => ({}) as RecentTokens,
    ),
    withinDeadline(
      isE2eTesting() ? readRecentMerges() : readCachedRecentMerges(),
      MERGES_DEADLINE_MS,
    ).catch(() => ({}) as RecentMerges),
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
    // A degraded snapshot may hold a stale or partial list; the frame shows
    // the count as unavailable rather than a number it cannot vouch for.
    ...(snapshot?.available ? { decisions: snapshot.decisions.length } : {}),
    ...tokens,
    ...merges,
  };
}
