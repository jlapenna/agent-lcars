'use client';

import { useCallback, useEffect, useState } from 'react';

// Per-browser only (#59) - deliberately not a GitHub label or a Firestore
// doc: muting is "get this out of my way for a while" on the maintainer's
// own console, not a signal any other viewer or automation should ever see
// (an agent still needs a human-needed item to show up as actionable
// everywhere else).
const STORAGE_KEY = 'agent-lcars:muted-queue-items';

function readStoredKeys(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    // Corrupt/unavailable storage (private browsing, quota, hand-edited
    // value) degrades to "nothing muted" rather than crashing the board.
    return [];
  }
}

function storeKeys(keys: Set<string>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Same defensive posture as readStoredKeys: a failed write just means
    // the mute doesn't survive a reload, not a crash.
  }
}

/**
 * Tracks which "Your Queue" items the maintainer has muted, keyed by
 * `repoItemKey`. State starts empty and hydrates from localStorage in an
 * effect (localStorage doesn't exist during server rendering), so a muted
 * item still renders once on a fresh load, then disappears.
 */
export function useMutedItems() {
  const [muted, setMuted] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setMuted(new Set(readStoredKeys()));
  }, []);

  const mute = useCallback((key: string) => {
    setMuted((prev) => {
      const next = new Set(prev);
      next.add(key);
      storeKeys(next);
      return next;
    });
  }, []);

  const unmute = useCallback((key: string) => {
    setMuted((prev) => {
      const next = new Set(prev);
      next.delete(key);
      storeKeys(next);
      return next;
    });
  }, []);

  return { muted, mute, unmute };
}
