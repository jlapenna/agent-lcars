/** Crockford base32 alphabet (no I, L, O, U) — the same alphabet
 *  `WORK_ID_RE` in `@agent-lcars/orchestrator` accepts. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const NATIVE_RUN_ID_RE = /^work:([0-9A-HJKMNP-TV-Z]{26})\/r\d+$/u;

/**
 * A ULID: 10 time characters (milliseconds since the epoch, base32,
 * most significant first) + 16 random characters. Browser- and Node-safe:
 * only `globalThis.crypto.getRandomValues` is used, so the `/work` create
 * form can mint the idempotency key client-side.
 */
export function ulid(now: number = Date.now()): string {
  let time = now;
  let prefix = '';
  for (let i = 0; i < 10; i += 1) {
    prefix = ALPHABET[time % 32] + prefix;
    time = Math.floor(time / 32);
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let suffix = '';
  for (const byte of bytes) suffix += ALPHABET[byte % 32];
  return prefix + suffix;
}

/** `work:<ulid>/r<n>` (a native orchestrator run id, also the dispatch
 *  marker's `intentId`) → `<ulid>`; anything else → `undefined`. */
export function workIdFromIntentId(intentId: string): string | undefined {
  return NATIVE_RUN_ID_RE.exec(intentId)?.[1];
}
