import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { refreshGithubSignIn } from './actions';
import { beginOperatorReauth, takePendingReply } from './operator-reauth';

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
    vi.mocked(refreshGithubSignIn).mockReset();
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
    beginOperatorReauth(REPLY);
    vi.advanceTimersByTime(1_500);

    expect(takePendingReply('jlapenna/homelab#7')).toBeUndefined();
    expect(takePendingReply(REPLY.itemKey)).toEqual({ ...REPLY, resend: true });
    expect(takePendingReply(REPLY.itemKey)).toBeUndefined();
  });

  it('restores a reply that came back late without sending it unprompted', () => {
    beginOperatorReauth(REPLY);
    vi.advanceTimersByTime(10 * 60_000);

    expect(takePendingReply(REPLY.itemKey)).toEqual({
      ...REPLY,
      resend: false,
    });
  });

  it('does not loop when a fresh token is refused too', () => {
    expect(beginOperatorReauth(REPLY)).toBe(true);
    takePendingReply(REPLY.itemKey);
    vi.advanceTimersByTime(5_000);

    expect(beginOperatorReauth(REPLY)).toBe(false);
    expect(refreshGithubSignIn).toHaveBeenCalledOnce();

    // A later refusal is an ordinary stale token again.
    vi.advanceTimersByTime(3 * 60_000);
    expect(beginOperatorReauth(REPLY)).toBe(true);
  });

  it('leaves the failure to the caller when this browser cannot remember the attempt', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    expect(beginOperatorReauth(REPLY)).toBe(false);
    expect(refreshGithubSignIn).not.toHaveBeenCalled();
  });
});
