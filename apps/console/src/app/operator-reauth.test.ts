import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { refreshGithubSignIn } from './actions';
import {
  beginOperatorReauth,
  takePendingDraft,
  takePendingReply,
} from './operator-reauth';

vi.mock('./actions', () => ({ refreshGithubSignIn: vi.fn() }));

const REPLY = {
  itemKey: 'jlapenna/homelab#42',
  body: 'Use option 2',
  target: 'claude' as const,
};

describe('operator re-authorization', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-11-12T06:00:00Z') });
    window.sessionStorage.clear();
    vi.mocked(refreshGithubSignIn).mockReset().mockResolvedValue(undefined);
    window.history.replaceState(
      null,
      '',
      '/inbox?item=jlapenna%2Fhomelab%2342',
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the browser to the page it left', () => {
    expect(beginOperatorReauth()).toBe(true);

    expect(refreshGithubSignIn).toHaveBeenCalledExactlyOnceWith(
      '/inbox?item=jlapenna%2Fhomelab%2342',
    );
  });

  it('hands the refused reply back once, to its own item, for resending', () => {
    beginOperatorReauth({ reply: REPLY });
    vi.advanceTimersByTime(1_500);

    expect(takePendingReply('jlapenna/homelab#7')).toBeUndefined();
    expect(takePendingReply(REPLY.itemKey)).toEqual({ ...REPLY, resend: true });
    expect(takePendingReply(REPLY.itemKey)).toBeUndefined();
  });

  it('restores a reply that came back late without sending it unprompted', () => {
    beginOperatorReauth({ reply: REPLY });
    vi.advanceTimersByTime(10 * 60_000);

    expect(takePendingReply(REPLY.itemKey)).toEqual({
      ...REPLY,
      resend: false,
    });
  });

  it('hands typed text back once, to the control it came from, and never sends it', () => {
    const draft = { key: 'retrigger:jlapenna/homelab#42', text: 'try again' };
    beginOperatorReauth({ draft });

    expect(takePendingDraft('retrigger:jlapenna/homelab#7')).toBeUndefined();
    expect(takePendingDraft(draft.key)).toBe('try again');
    expect(takePendingDraft(draft.key)).toBeUndefined();
  });

  it('navigates without leaving an unhandled rejection behind', async () => {
    // Next reports the redirect by rejecting the action's promise.
    vi.mocked(refreshGithubSignIn).mockRejectedValue(
      new Error('NEXT_REDIRECT'),
    );
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(beginOperatorReauth()).toBe(true);
      await vi.runAllTimersAsync();
      await Promise.resolve();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('never resends a reply it could not remove from storage', () => {
    beginOperatorReauth({ reply: REPLY });
    // Storage accepted the stash, then stopped accepting writes (quota).
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    // Every mount still reads the same reply, so none of them may post it.
    expect(takePendingReply(REPLY.itemKey)).toEqual({
      ...REPLY,
      resend: false,
    });
    expect(takePendingReply(REPLY.itemKey)).toEqual({
      ...REPLY,
      resend: false,
    });
  });

  it('does not loop when a fresh token is refused too', () => {
    expect(beginOperatorReauth({ reply: REPLY })).toBe(true);
    takePendingReply(REPLY.itemKey);
    vi.advanceTimersByTime(5_000);

    expect(beginOperatorReauth({ reply: REPLY })).toBe(false);
    expect(refreshGithubSignIn).toHaveBeenCalledOnce();

    // A later refusal is an ordinary stale token again.
    vi.advanceTimersByTime(3 * 60_000);
    expect(beginOperatorReauth({ reply: REPLY })).toBe(true);
  });

  it('leaves the failure to the caller when this browser cannot remember the attempt', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    expect(beginOperatorReauth({ reply: REPLY })).toBe(false);
    expect(refreshGithubSignIn).not.toHaveBeenCalled();
  });
});
