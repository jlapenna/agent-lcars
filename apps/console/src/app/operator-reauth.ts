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

/** Text typed into a control whose action was refused (a retrigger note,
 * unstick-prs context), restored for the operator to send again. */
export interface PendingDraft {
  /** Identifies the control instance the text belongs to. */
  key: string;
  text: string;
}

interface StoredReauth {
  at: number;
  reply?: PendingReply;
  draft?: PendingDraft;
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
 * Starts the GitHub re-authorization round trip, remembering what the
 * operator typed: a `reply` is sent on return, a `draft` is put back in its
 * control. Returns false when the caller should show the failure instead: a
 * re-authorization just happened and did not help, or this browser cannot
 * remember the attempt (so nothing would stop a loop).
 */
export function beginOperatorReauth(
  pending: { reply?: PendingReply; draft?: PendingDraft } = {},
): boolean {
  const now = Date.now();
  const prior = read();
  if (prior !== undefined && now - prior.at < LOOP_GUARD_MS) return false;
  if (!write({ at: now, ...pending })) return false;
  // The action ends in a redirect to GitHub, which Next reports by rejecting
  // this promise just before it navigates. A real failure leaves the page
  // where it is, with the operator's text still in place.
  refreshGithubSignIn(window.location.pathname + window.location.search).catch(
    () => undefined,
  );
  return true;
}

/**
 * Hands back, once, the reply that was refused for `itemKey` before the last
 * re-authorization. `resend` is false when too long has passed to send it
 * unprompted, or when it could not be removed from storage; the text is
 * still restored.
 */
export function takePendingReply(
  itemKey: string,
): (PendingReply & { resend: boolean }) | undefined {
  const stored = read();
  if (stored?.reply?.itemKey !== itemKey) return undefined;
  // Keep `at`: it is what stops a second automatic round trip if the resend
  // is refused too.
  const { reply: _taken, ...rest } = stored;
  // Resending is only safe once the reply is provably gone from storage:
  // if it cannot be removed, the next mount would read it and post it again.
  // The text is still handed back so the operator can send it themselves.
  const consumed = write(rest);
  return {
    ...stored.reply,
    resend: consumed && Date.now() - stored.at < RESEND_WINDOW_MS,
  };
}

/** Hands back, once, the text typed into the control `key` before the last
 * re-authorization. It is never sent unprompted. */
export function takePendingDraft(key: string): string | undefined {
  const stored = read();
  if (stored?.draft?.key !== key) return undefined;
  const { draft, ...rest } = stored;
  write(rest);
  return draft.text;
}
