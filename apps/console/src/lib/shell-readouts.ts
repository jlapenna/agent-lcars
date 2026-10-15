import { isE2eTesting } from '@agent-lcars/util-server';
import { cacheLife } from 'next/cache';
import type { Session } from 'next-auth';

import { context as workContext } from '../app/work/context';
import { auth } from '../auth';
import { DASHBOARD_CACHE_LIFE, getCachedAgentActivity } from './dashboard-data';
import { consoleUrl } from './deployment';
import { loadInboxNotificationSnapshot } from './inbox-notifications-data';
import { mergedLastDay } from './merged-pulls';
import { getSessionArchive } from './session-archive';

/**
 * The figures the console frame shows on every page: the rail readouts, the
 * destination counts and the signed-in identity. A field is absent when its
 * source could not be read, which the frame renders as unavailable, never as
 * a zero.
 */
export interface ShellReadouts extends ShellIdentity {
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

/** Who is signed in and where: the frame's identity block and the rail's
 * environment line. Read from the session and the configured grants alone,
 * so the root layout supplies it with the first paint. */
export interface ShellIdentity {
  user: { login: string; initials: string; grants: string[] };
  /** Host the console is served from, the rail's environment line. */
  environment: string;
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

async function readCachedRecentTokens(): Promise<RecentTokens> {
  'use cache';
  cacheLife(DASHBOARD_CACHE_LIFE);
  return readRecentTokens();
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

async function identityOf(session: Session): Promise<ShellIdentity> {
  const login = session.user.login ?? session.user.name ?? '';
  const grants = await workContext()
    .then((ctx) => [...(ctx.principal?.scopes ?? [])].sort())
    .catch(() => [] as string[]);
  return {
    user: {
      login,
      initials: initialsOf(login || '?'),
      grants: [...(session.user.isAdmin ? ['admin'] : []), ...grants],
    },
    environment: environmentLabel(),
  };
}

export async function loadShellIdentity(): Promise<ShellIdentity | undefined> {
  const session = await auth();
  return session?.user ? identityOf(session) : undefined;
}

export async function loadShellReadouts(): Promise<ShellReadouts | undefined> {
  const session = await auth();
  if (!session?.user) return undefined;
  const base: ShellReadouts = {
    ...(await identityOf(session)),
    observedAt: new Date().toISOString(),
  };
  if (!session.user.isAdmin) return base;

  const [activity, snapshot, tokens, merges] = await Promise.all([
    getCachedAgentActivity().catch(() => undefined),
    loadInboxNotificationSnapshot().catch(() => undefined),
    (isE2eTesting() ? readRecentTokens() : readCachedRecentTokens()).catch(
      () => ({}) as RecentTokens,
    ),
    // Counted from GitHub across the watched repositories, so merges no
    // recorded session referenced still count.
    mergedLastDay().then((merged): RecentMerges =>
      merged === undefined
        ? {}
        : { merged24h: merged.count, merged24hPartial: merged.partial },
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
    // A degraded snapshot may hold a stale or partial list; the frame shows
    // the count as unavailable rather than a number it cannot vouch for.
    ...(snapshot?.available ? { decisions: snapshot.decisions.length } : {}),
    ...tokens,
    ...merges,
  };
}
