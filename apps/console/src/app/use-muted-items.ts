'use client';

import { useCallback, useEffect, useState } from 'react';

// Per-browser only (#59) - deliberately not a GitHub label or a Firestore
// doc: muting is "get this out of my way for a while" on the maintainer's
// own console, not a signal any other viewer or automation should ever see
// (an agent still needs a needs-human item to show up as actionable
// everywhere else).
const STORAGE_KEY = 'agent-lcars:muted-queue-items';

/**
 * `repoItemKey` -> the item's `updatedAt` when it was muted, or null for a
 * mute with no expiry (only produced by migrating the legacy `string[]`
 * format, which predates expiry). A mute recorded against one `updatedAt`
 * stops matching the moment the item changes - "muted until something new
 * happens", so a mute can never hide fresh activity.
 */
type MutedEntries = Record<string, string | null>;

function readStoredEntries(): MutedEntries {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    // Legacy format: a bare array of keys, muted forever. Kept working so
    // an existing browser's mutes survive the upgrade.
    if (Array.isArray(parsed)) {
      return Object.fromEntries(
        parsed
          .filter((key): key is string => typeof key === 'string')
          .map((key) => [key, null]),
      );
    }
    if (parsed && typeof parsed === 'object') {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          ([, value]) => typeof value === 'string' || value === null,
        ),
      ) as MutedEntries;
    }
    return {};
  } catch {
    // Corrupt/unavailable storage (private browsing, quota, hand-edited
    // value) degrades to "nothing muted" rather than crashing the board.
    return {};
  }
}

function storeEntries(entries: MutedEntries) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Same defensive posture as readStoredEntries: a failed write just
    // means the mute doesn't survive a reload, not a crash.
  }
}

/**
 * Tracks which queue items the maintainer has muted, keyed by
 * `repoItemKey`. State starts empty and hydrates from localStorage in an
 * effect (localStorage doesn't exist during server rendering), so a muted
 * item still renders once on a fresh load, then disappears.
 *
 * A mute records the item's `updatedAt` at mute time and expires the
 * moment the item updates again - new activity always resurfaces.
 */
export function useMutedItems() {
  const [entries, setEntries] = useState<MutedEntries>(() => ({}));

  useEffect(() => {
    setEntries(readStoredEntries());
  }, []);

  const mute = useCallback((key: string, updatedAt?: string) => {
    setEntries((prev) => {
      const next = { ...prev, [key]: updatedAt ?? null };
      storeEntries(next);
      return next;
    });
  }, []);

  const unmute = useCallback((key: string) => {
    setEntries((prev) => {
      const next = { ...prev };
      delete next[key];
      storeEntries(next);
      return next;
    });
  }, []);

  const isMuted = useCallback(
    (key: string, updatedAt?: string) => {
      if (!(key in entries)) return false;
      const mutedAt = entries[key];
      // Legacy no-expiry mute, or a caller with no timestamp to compare.
      if (mutedAt === null || updatedAt === undefined) return true;
      return mutedAt === updatedAt;
    },
    [entries],
  );

  return { isMuted, mute, unmute };
}
