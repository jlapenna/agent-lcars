'use client';

import { useCallback, useEffect, useState } from 'react';

import type { ActionItem } from '../lib/action-items';

// Per-browser only (#59) - deliberately not a GitHub label or a Firestore
// doc: muting is "get this out of my way for a while" on the maintainer's
// own console, not a signal any other viewer or automation should ever see
// (an agent still needs a needs-human item to show up as actionable
// everywhere else).
const STORAGE_KEY = 'agent-lcars:muted-queue-items';

/**
 * What "the item changed" means for mute expiry. `issue.updated_at` alone
 * is not enough: run-failed/ciRunning/silent-error are derived from check
 * runs and telemetry that never touch the issue timestamp (Codex review
 * on #497, P1) - so the signature also folds in the classification that
 * makes the row actionable. Any new CI outcome or reclassification
 * resurfaces a muted row.
 */
export function muteSignatureFor(
  item: Pick<ActionItem, 'updatedAt' | 'actionTypes' | 'ciRunning'>,
): string {
  return [
    item.updatedAt,
    [...item.actionTypes].sort().join('+'),
    item.ciRunning ? 'ci' : '',
  ].join('|');
}

/**
 * `repoItemKey` -> the item's mute signature (muteSignatureFor) when it
 * was muted, or null for a mute with no expiry (only produced by
 * migrating the legacy `string[]` format, which predates expiry). A mute
 * recorded against one signature stops matching the moment the item
 * changes - "muted until something new happens", so a mute can never hide
 * fresh activity.
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

  const mute = useCallback((key: string, version?: string) => {
    setEntries((prev) => {
      const next = { ...prev, [key]: version ?? null };
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
    (key: string, version?: string) => {
      if (!(key in entries)) return false;
      const mutedVersion = entries[key];
      // Legacy no-expiry mute, or a caller with no signature to compare.
      if (mutedVersion === null || version === undefined) return true;
      return mutedVersion === version;
    },
    [entries],
  );

  return { isMuted, mute, unmute };
}
