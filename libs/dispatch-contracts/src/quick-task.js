/**
 * Quick Task identity: the hidden request marker and the semantic digest that
 * ties an issue back to the console request that created it.
 *
 * This was the most fragile duplication in the repo, and not obviously so.
 * The console and the broker each hand-wrote a digest as
 * `sha256(JSON.stringify({ repository, pipeline, title, description }))` — in
 * different languages, over independently authored object literals. Plain
 * `JSON.stringify` serializes keys in **insertion order**, so the two agreed
 * only because both literals happened to list the same four fields in the
 * same sequence. Reordering either one — an edit that reads as pure
 * housekeeping, with no behavioural smell at all — would silently stop every
 * digest matching.
 *
 * And it would not fail quietly: `quickTaskRequest` throws
 * `'Quick Task marker digest mismatch'` on no match, which is exactly the
 * regression #645's Phase 2 names — a single module crashing the whole
 * signal-normalization step.
 *
 * The marker regexes had drifted too: the broker required a real UUID v4
 * while the console accepted any 36-character hex-and-dash string.
 *
 * One definition now, with the exact existing wire format preserved — see
 * `serializeIdentity` for why the field order must not be "cleaned up", and
 * `quick-task.spec.js` for the pinned digest that enforces it.
 */

/**
 * The fields that define a Quick Task's identity. Two requests with the same
 * values are the same task, however many times the console retried.
 *
 * @typedef {object} QuickTaskIdentity
 * @property {string} repository `owner/name`.
 * @property {string} pipeline
 * @property {string} title
 * @property {string} description
 */

/**
 * Serialize identity fields for hashing.
 *
 * **This key order is wire format. Do not change it, and do not "improve" it
 * by sorting.** `JSON.stringify` emits keys in insertion order, so this
 * sequence is baked into the digest of every Quick Task marker already
 * written into a live GitHub issue. Reordering it would recompute every
 * existing marker's digest to a different value, and the next label event on
 * any of those issues would throw `'Quick Task marker digest mismatch'` —
 * turning a cosmetic edit into a production outage.
 *
 * A canonical sorted-key serializer would be the better design if this were
 * greenfield; it is not, and migrating live markers is not worth it. Instead
 * `quick-task.spec.js` pins the digest of a fixed input, so a reorder fails
 * loudly in tests instead of silently in production.
 *
 * @param {QuickTaskIdentity} identity
 * @returns {string}
 */
function serializeIdentity({ repository, pipeline, title, description }) {
  return JSON.stringify({ repository, pipeline, title, description });
}

/**
 * The semantic digest of a Quick Task request.
 *
 * Takes an injected hasher so this module stays dependency-free: the broker
 * runs under bare node with `node:crypto`, the console runs in a Next server
 * action with its own import, and this package must not reach for either (see
 * pipelines.js's header — a node builtin here would break a `'use client'`
 * bundle).
 *
 * @param {QuickTaskIdentity} identity
 * @param {(input: string) => string} sha256Hex Hashes a UTF-8 string to
 *   lowercase hex.
 * @returns {string}
 */
export function quickTaskDigest(identity, sha256Hex) {
  return sha256Hex(serializeIdentity(identity));
}

/**
 * The hidden marker the console writes into a Quick Task issue body and the
 * broker reads back out.
 *
 * `id` is a UUID v4 and is validated as one: accepting a looser shape on the
 * read side (which the console's copy did) means a hand-edited or crafted
 * body could smuggle an ID the writer would never mint.
 */
const QUICK_TASK_MARKER_SOURCE =
  '<!-- agent-lcars:quick-task-request:v1 id=([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) digest=([0-9a-f]{64}) -->';

/** Non-global: for testing or matching a single marker. */
export const QUICK_TASK_MARKER_RE = new RegExp(QUICK_TASK_MARKER_SOURCE, 'u');

/**
 * A fresh global-flagged matcher. Returned as a new object each call rather
 * than shared, because a global regex carries mutable `lastIndex` — a shared
 * instance silently skips matches depending on who used it last.
 *
 * @returns {RegExp}
 */
export function quickTaskMarkerMatcher() {
  return new RegExp(QUICK_TASK_MARKER_SOURCE, 'gu');
}

/**
 * Render the marker.
 *
 * @param {{ requestId: string, digest: string }} request
 * @returns {string}
 */
export function formatQuickTaskMarker({ requestId, digest }) {
  return `<!-- agent-lcars:quick-task-request:v1 id=${requestId} digest=${digest} -->`;
}

/**
 * Recover a marker's request ID and digest.
 *
 * @param {string | undefined | null} body
 * @returns {{ requestId: string, digest: string } | undefined}
 */
export function parseQuickTaskMarker(body) {
  const match = body?.match(QUICK_TASK_MARKER_RE);
  return match ? { requestId: match[1], digest: match[2] } : undefined;
}
