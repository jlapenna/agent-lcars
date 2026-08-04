import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { muteSignatureFor, useMutedItems } from './use-muted-items';

const STORAGE_KEY = 'agent-lcars:muted-queue-items';

describe('useMutedItems', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('mutes against the item updatedAt and expires when the item changes', () => {
    const { result } = renderHook(() => useMutedItems());

    act(() => result.current.mute('a/b#1', '2026-08-01T00:00:00Z'));
    expect(result.current.isMuted('a/b#1', '2026-08-01T00:00:00Z')).toBe(true);
    // New activity on the item: the mute no longer applies.
    expect(result.current.isMuted('a/b#1', '2026-08-02T09:00:00Z')).toBe(false);
    expect(result.current.isMuted('other#2', '2026-08-01T00:00:00Z')).toBe(
      false,
    );
  });

  it('expires when only the classification changes (CI/telemetry activity)', () => {
    const before = muteSignatureFor({
      updatedAt: '2026-08-01T00:00:00Z',
      actionTypes: ['review-requested'],
      ciRunning: false,
    });
    const afterCi = muteSignatureFor({
      updatedAt: '2026-08-01T00:00:00Z',
      actionTypes: ['review-requested', 'run-failed'],
      ciRunning: false,
    });
    expect(afterCi).not.toBe(before);

    const { result } = renderHook(() => useMutedItems());
    act(() => result.current.mute('a/b#1', before));
    expect(result.current.isMuted('a/b#1', before)).toBe(true);
    // A failed run reclassified the item without touching issue.updated_at.
    expect(result.current.isMuted('a/b#1', afterCi)).toBe(false);
  });

  it('unmute removes the entry', () => {
    const { result } = renderHook(() => useMutedItems());
    act(() => result.current.mute('a/b#1', '2026-08-01T00:00:00Z'));
    act(() => result.current.unmute('a/b#1'));
    expect(result.current.isMuted('a/b#1', '2026-08-01T00:00:00Z')).toBe(false);
  });

  it('migrates the legacy string[] format as no-expiry mutes', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['a/b#1']));
    const { result } = renderHook(() => useMutedItems());
    expect(result.current.isMuted('a/b#1', '2026-08-05T00:00:00Z')).toBe(true);
  });

  it('degrades corrupt storage to nothing muted', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json');
    const { result } = renderHook(() => useMutedItems());
    expect(result.current.isMuted('a/b#1')).toBe(false);
  });

  it('persists across hook instances', () => {
    const first = renderHook(() => useMutedItems());
    act(() => first.result.current.mute('a/b#1', '2026-08-01T00:00:00Z'));
    first.unmount();

    const second = renderHook(() => useMutedItems());
    expect(second.result.current.isMuted('a/b#1', '2026-08-01T00:00:00Z')).toBe(
      true,
    );
  });
});
