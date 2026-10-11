'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type DecisionSnoozeAnchor,
  type DecisionSnoozeResult,
  type DecisionSnoozes,
  LEGACY_MUTE_STORAGE_KEY,
  parseLegacyMutes,
  type SnoozeDecisionInput,
} from '../lib/decision-snooze-contract';
import {
  importDecisionSnoozes,
  readDecisionSnoozes,
  snoozeDecision,
  unsnoozeDecision,
} from './decision-snooze-actions';

export function useDecisionSnoozes() {
  const [entries, setEntries] = useState<DecisionSnoozes>({});
  const [legacy, setLegacy] = useState<Record<string, string | null>>({});
  const [now, setNow] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const revision = useRef(0);
  const changing = useRef(false);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    if (changing.current) return;
    const started = ++revision.current;
    try {
      const result = await readDecisionSnoozes();
      if (!mounted.current || started !== revision.current) return;
      if (result.ok) {
        setEntries(result.entries);
        setError(undefined);
      } else setError(result.error);
    } catch {
      if (mounted.current && started === revision.current)
        setError('Unable to load your snoozes. Try refreshing.');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    try {
      setLegacy(
        parseLegacyMutes(window.localStorage.getItem(LEGACY_MUTE_STORAGE_KEY)),
      );
    } catch {
      /* Storage may be unavailable. */
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);

  useEffect(() => {
    let timeout: number | undefined;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      const next = Math.min(
        ...Object.values(entries)
          .map((entry) => Date.parse(entry.expiresAt))
          .filter((expiry) => expiry > current),
      );
      if (Number.isFinite(next))
        timeout = window.setTimeout(
          tick,
          Math.min(next - current, 2_147_483_647),
        );
    };
    const visible = () => {
      window.clearTimeout(timeout);
      tick();
    };
    tick();
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [entries]);

  const change = useCallback(
    async (operation: () => Promise<DecisionSnoozeResult>) => {
      if (changing.current) return false;
      changing.current = true;
      ++revision.current; // A pre-write read must never resurrect an unsnooze.
      setPending(true);
      setError(undefined);
      try {
        const result = await operation();
        if (!mounted.current) return false;
        if (!result.ok) {
          setError(result.error);
          return false;
        }
        setEntries(result.entries);
        return true;
      } catch {
        if (mounted.current)
          setError('Unable to save your snoozes. Try again.');
        return false;
      } finally {
        changing.current = false;
        if (mounted.current) setPending(false);
      }
    },
    [],
  );

  const snooze = useCallback(
    (input: SnoozeDecisionInput) => change(() => snoozeDecision(input)),
    [change],
  );
  const unsnooze = useCallback(
    (input: DecisionSnoozeAnchor) => change(() => unsnoozeDecision(input)),
    [change],
  );
  const importLegacy = useCallback(
    async (anchors: DecisionSnoozeAnchor[]) => {
      if (!(await change(() => importDecisionSnoozes(anchors)))) return false;
      try {
        const remaining = parseLegacyMutes(
          window.localStorage.getItem(LEGACY_MUTE_STORAGE_KEY),
        );
        for (const { anchor } of anchors)
          if (remaining[anchor] === legacy[anchor]) delete remaining[anchor];
        if (Object.keys(remaining).length)
          window.localStorage.setItem(
            LEGACY_MUTE_STORAGE_KEY,
            JSON.stringify(remaining),
          );
        else window.localStorage.removeItem(LEGACY_MUTE_STORAGE_KEY);
        setLegacy(remaining);
      } catch {
        /* Durable import succeeded; unrelated storage is never removed. */
      }
      return true;
    },
    [change, legacy],
  );
  const isSnoozed = useCallback(
    (anchor: string, signature: string) => {
      const entry = Object.hasOwn(entries, anchor)
        ? entries[anchor]
        : undefined;
      return Boolean(
        entry &&
        entry.signature === signature &&
        Date.parse(entry.expiresAt) > now,
      );
    },
    [entries, now],
  );

  const activeEntries = Object.fromEntries(
    Object.entries(entries).filter(
      ([, entry]) => Date.parse(entry.expiresAt) > now,
    ),
  );
  return {
    entries: activeEntries,
    legacy,
    pending,
    error,
    snooze,
    unsnooze,
    importLegacy,
    isSnoozed,
  };
}
