import type { Pipeline } from '../lib/primary-action';
import { refreshGithubSignIn } from './actions';

/**
 * Recovers from GitHub refusing the operator's user token without a manual
 * sign-out. The browser goes through GitHub's authorization once more (the
 * console is already authorized, so it comes straight back) and the reply
 * that was refused is sent again on return.
 *
 * State lives in sessionStorage because the round trip is a full navigation:
 * it has to outlive the page, and must not reach another tab or device.
 */
const STORAGE_KEY = 'lcars.operator-reauth';

/** A refusal this soon after a re-authorization means a fresh token did not
 * help, so the console stops and shows the message instead of looping. */
const LOOP_GUARD_MS = 2 * 60_000;

/** How long after leaving a refused reply is still sent automatically. A
 * round trip that took longer restores the text for the operator to send. */
const RESEND_WINDOW_MS = 2 * 60_000;

/** A reply GitHub refused, kept so it can be sent after re-authorization. */
export interface PendingReply {
  /** `repoItemKey` of the item the reply belongs to. */
  itemKey: string;
  body: string;
  /** The hand-off agent the operator picked for this reply, if any. */
  target?: Pipeline;
}

interface StoredReauth {
  at: number;
  reply?: PendingReply;
}

function read(): StoredReauth | undefined {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as StoredReauth).at !== 'number'
    ) {
      return undefined;
    }
    return parsed as StoredReauth;
  } catch {
    return undefined;
  }
}

function write(value: StoredReauth): boolean {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts the GitHub re-authorization round trip, remembering `reply` so it is
 * sent on return. Returns false when the caller should show the failure
 * instead: a re-authorization just happened and did not help, or this browser
 * cannot remember the attempt (so nothing would stop a loop).
 */
export function beginOperatorReauth(reply?: PendingReply): boolean {
  const now = Date.now();
  const prior = read();
  if (prior !== undefined && now - prior.at < LOOP_GUARD_MS) return false;
  if (!write({ at: now, ...(reply === undefined ? {} : { reply }) })) {
    return false;
  }
  void refreshGithubSignIn(window.location.pathname + window.location.search);
  return true;
}

/**
 * Hands back, once, the reply that was refused for `itemKey` before the last
 * re-authorization. `resend` is false when too long has passed to send it
 * unprompted; the text is still restored.
 */
export function takePendingReply(
  itemKey: string,
): (PendingReply & { resend: boolean }) | undefined {
  const stored = read();
  if (stored?.reply?.itemKey !== itemKey) return undefined;
  // Keep `at`: it is what stops a second automatic round trip if the resend
  // is refused too.
  write({ at: stored.at });
  return {
    ...stored.reply,
    resend: Date.now() - stored.at < RESEND_WINDOW_MS,
  };
}
