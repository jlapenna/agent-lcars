import type { SessionDoc } from '@agent-lcars/telemetry';
import { Timestamp } from '@google-cloud/firestore';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The initial window read has no Firestore read time, so its `writtenAt`
 * watermark comes from this host's clock, taken before the read and moved
 * back by this margin so a skewed clock cannot skip a commit.
 */
const CLOCK_SKEW_MS = 60_000;

/**
 * Writers built before the `writtenAt` stamp (older runner images and
 * workstation bundles) are caught by re-reading the sessions active since
 * the previous sync, less this overlap for a final write that lands after
 * its last activity.
 */
const UNSTAMPED_OVERLAP_MS = 15 * 60_000;

export interface SessionArchiveSyncDeps {
  /** Sessions whose `lastActivityAt` is at or after the ISO timestamp. */
  listActiveSince(activeSince: string): Promise<SessionDoc[]>;
  /** Sessions whose `writtenAt` stamp is at or after `since`, and the time
   * the read observed. */
  listWrittenSince(
    since: Timestamp,
  ): Promise<{ docs: SessionDoc[]; readTime: Timestamp }>;
  now(): number;
}

export interface SessionArchiveSync {
  /** Every session active within `days` (at most {@link windowDays}) as of
   * this call, newest activity first. Throws when Firestore cannot be read,
   * rather than answering from an older copy. */
  read(days: number): Promise<SessionDoc[]>;
  readonly windowDays: number;
}

/**
 * An in-memory copy of the session archive that each read brings up to date
 * by fetching only what changed since the previous read.
 *
 * The first read loads the whole window. Every later read asks Firestore
 * for the documents written since the last read's observed time (the
 * `writtenAt` server stamp every writer sets) and merges them by session
 * id. A read therefore reflects every write committed before it started,
 * at the cost of the few documents that changed instead of the thousands
 * in the window.
 *
 * Concurrent reads share one refresh: a read that arrives while another is
 * refreshing waits for that refresh, which started at most one Firestore
 * round trip earlier.
 */
export function createSessionArchiveSync(
  deps: SessionArchiveSyncDeps,
  windowDays: number,
): SessionArchiveSync {
  let docs = new Map<string, SessionDoc>();
  let writtenSince: Timestamp | undefined;
  let lastSyncAt = 0;
  let refreshing: Promise<void> | undefined;

  async function refresh(): Promise<void> {
    const started = deps.now();
    const windowStart = new Date(started - windowDays * DAY_MS).toISOString();
    if (writtenSince === undefined) {
      const loaded = await deps.listActiveSince(windowStart);
      docs = new Map(loaded.map((doc) => [doc.sessionId, doc]));
      writtenSince = Timestamp.fromMillis(started - CLOCK_SKEW_MS);
    } else {
      const [unstamped, written] = await Promise.all([
        deps.listActiveSince(
          new Date(lastSyncAt - UNSTAMPED_OVERLAP_MS).toISOString(),
        ),
        deps.listWrittenSince(writtenSince),
      ]);
      // The stamped read is authoritative for any document both return.
      for (const doc of [...unstamped, ...written.docs])
        docs.set(doc.sessionId, doc);
      writtenSince = written.readTime;
    }
    lastSyncAt = started;
    for (const [id, doc] of docs)
      if (doc.lastActivityAt < windowStart) docs.delete(id);
  }

  return {
    windowDays,
    async read(days) {
      if (days > windowDays)
        throw new RangeError(`Archive sync holds ${windowDays} days`);
      refreshing ??= refresh().finally(() => {
        refreshing = undefined;
      });
      await refreshing;
      const since = new Date(deps.now() - days * DAY_MS).toISOString();
      return [...docs.values()]
        .filter((doc) => doc.lastActivityAt >= since)
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    },
  };
}
