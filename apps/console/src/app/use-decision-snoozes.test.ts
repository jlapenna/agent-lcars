import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type DecisionSnoozeResult,
  type DecisionSnoozes,
  LEGACY_MUTE_STORAGE_KEY,
} from '../lib/decision-snooze-contract';
import { useDecisionSnoozes } from './use-decision-snoozes';

const actions = vi.hoisted(() => ({
  readDecisionSnoozes: vi.fn(),
  snoozeDecision: vi.fn(),
  unsnoozeDecision: vi.fn(),
  importDecisionSnoozes: vi.fn(),
}));
vi.mock('./decision-snooze-actions', () => actions);
const now = Date.parse('2026-10-09T00:00:00Z');
function entries(expiry = now + 60_000): DecisionSnoozes {
  return {
    'a/b#1': {
      signature: 'before',
      snoozedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiry).toISOString(),
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('authenticated decision snoozes', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'Date',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
      ],
    });
    vi.setSystemTime(now);
    window.localStorage.clear();
    actions.readDecisionSnoozes.mockResolvedValue({ ok: true, entries: {} });
    actions.snoozeDecision.mockResolvedValue({ ok: true, entries: entries() });
    actions.unsnoozeDecision.mockResolvedValue({ ok: true, entries: {} });
    actions.importDecisionSnoozes.mockResolvedValue({
      ok: true,
      entries: entries(now + 1440 * 60_000),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it('loads across mounts and resurfaces changes or expiry without a server update', async () => {
    actions.readDecisionSnoozes.mockResolvedValue({
      ok: true,
      entries: entries(),
    });
    const first = renderHook(useDecisionSnoozes);
    await act(async () => {
      await Promise.resolve();
    });
    expect(first.result.current.isSnoozed('a/b#1', 'before')).toBe(true);
    expect(first.result.current.isSnoozed('a/b#1', 'new decision')).toBe(false);
    first.unmount();
    const second = renderHook(useDecisionSnoozes);
    await act(async () => {
      await Promise.resolve();
    });
    expect(second.result.current.isSnoozed('a/b#1', 'before')).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(second.result.current.isSnoozed('a/b#1', 'before')).toBe(false);
    expect(second.result.current.entries).toEqual({});
  });

  it('refreshes another device’s changes on focus and while the Inbox is open', async () => {
    const hook = renderHook(useDecisionSnoozes);
    await act(async () => {
      await Promise.resolve();
    });
    actions.readDecisionSnoozes.mockResolvedValue({
      ok: true,
      entries: entries(),
    });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(hook.result.current.isSnoozed('a/b#1', 'before')).toBe(true);
    actions.readDecisionSnoozes.mockResolvedValue({ ok: true, entries: {} });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(hook.result.current.isSnoozed('a/b#1', 'before')).toBe(false);
  });

  it('does not let an older read resurrect a completed unsnooze', async () => {
    const old = deferred<DecisionSnoozeResult>();
    actions.readDecisionSnoozes.mockReturnValue(old.promise);
    const hook = renderHook(useDecisionSnoozes);
    await act(async () => {
      await hook.result.current.unsnooze({
        anchor: 'a/b#1',
        signature: 'before',
      });
    });
    await act(async () => {
      old.resolve({ ok: true, entries: entries() });
    });
    expect(hook.result.current.entries).toEqual({});
  });

  it('keeps a decision visible when persistence fails and reports an actionable error', async () => {
    actions.snoozeDecision.mockResolvedValue({ ok: false, error: 'Try again' });
    const hook = renderHook(useDecisionSnoozes);
    await act(async () => {
      await hook.result.current.snooze({
        anchor: 'a/b#1',
        signature: 'before',
        minutes: 15,
      });
    });
    expect(hook.result.current.isSnoozed('a/b#1', 'before')).toBe(false);
    expect(hook.result.current.error).toBe('Try again');
    expect(hook.result.current.pending).toBe(false);
  });

  it('imports legacy mutes only explicitly, preserving unrelated and unmatched browser preferences', async () => {
    window.localStorage.setItem('theme', 'dark');
    window.localStorage.setItem(
      LEGACY_MUTE_STORAGE_KEY,
      JSON.stringify(['a/b#1', 'a/b#2']),
    );
    const hook = renderHook(useDecisionSnoozes);
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.legacy).toEqual({
      'a/b#1': null,
      'a/b#2': null,
    });
    expect(hook.result.current.isSnoozed('a/b#1', 'before')).toBe(false);
    expect(actions.importDecisionSnoozes).not.toHaveBeenCalled();
    await act(async () => {
      await hook.result.current.importLegacy([
        { anchor: 'a/b#1', signature: 'before' },
      ]);
    });
    expect(hook.result.current.isSnoozed('a/b#1', 'before')).toBe(true);
    expect(
      JSON.parse(window.localStorage.getItem(LEGACY_MUTE_STORAGE_KEY)!),
    ).toEqual({ 'a/b#2': null });
    expect(window.localStorage.getItem('theme')).toBe('dark');
  });

  it('does not clear legacy state when durable import fails', async () => {
    window.localStorage.setItem(
      LEGACY_MUTE_STORAGE_KEY,
      JSON.stringify(['a/b#1']),
    );
    actions.importDecisionSnoozes.mockResolvedValue({
      ok: false,
      error: 'Retry import',
    });
    const hook = renderHook(useDecisionSnoozes);
    await act(async () => {
      await hook.result.current.importLegacy([
        { anchor: 'a/b#1', signature: 'before' },
      ]);
    });
    expect(
      JSON.parse(window.localStorage.getItem(LEGACY_MUTE_STORAGE_KEY)!),
    ).toEqual(['a/b#1']);
  });

  it('ignores unavailable or corrupt local storage without hiding any decision', async () => {
    window.localStorage.setItem(LEGACY_MUTE_STORAGE_KEY, '{broken');
    const hook = renderHook(useDecisionSnoozes);
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.legacy).toEqual({});
    expect(hook.result.current.entries).toEqual({});
  });
});
