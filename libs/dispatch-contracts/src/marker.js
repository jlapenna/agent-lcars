/**
 * The dispatch attempt marker: `[dispatch:g<generation>:<intentId>]`.
 *
 * It is the join key between a broker generation and the GitHub Actions run
 * that executed it. The worker workflows embed it in `run-name:`, so it
 * survives in `display_title` on every run listing — which is what lets the
 * broker rebind a run after a lost dispatch response, and what lets the
 * console attribute a run to the exact attempt (not merely to the issue).
 *
 * It had three independent implementations: two hand-built template literals
 * inside `.github/actions/dispatch-broker` (main.mjs's `assertWorkerRun` and
 * github-api.mjs's `findRunsForGeneration`, unguarded duplicates of each
 * other), the console's `DISPATCH_MARKER_RE`, and four copy-pasted `run-name:`
 * strings in YAML. Only the YAML-to-console join was contract-tested; the two
 * broker copies were not covered at all.
 */

/**
 * Anchored to the marker's own delimiters rather than to the end of the title,
 * because `run-name:` puts the issue number and role text in front of it.
 * The intent-ID character class matches what the broker mints plus the `:` and
 * `.` separators older intent IDs used.
 */
const DISPATCH_MARKER_RE = /\[dispatch:g(\d+):([A-Za-z0-9._:-]+)\]/u;

/** The same shape as the marker's interior, anchored so a bare attempt ID is
 * matched in full rather than found inside a longer string. */
const ATTEMPT_ID_RE = /^g(\d+):([A-Za-z0-9._:-]+)$/u;

/**
 * @typedef {object} AttemptMarker
 * @property {number} generation
 * @property {string} intentId
 */

/**
 * The attempt's stable identity: `g<generation>:<intentId>`.
 *
 * #645 asks for "one immutable attemptId and workflow-run binding" per
 * attempt. This derives it from the intent and generation rather than minting
 * a fresh random value, for a specific reason: GitHub's API does not return a
 * run's dispatch-time inputs on the run object, so `display_title` is the only
 * channel a bound run and a ledger entry actually share. A minted ID would
 * therefore have to be encoded into the run title anyway — at which point it
 * is a second identifier that can disagree with the marker already there.
 *
 * Deriving it makes the two the same fact by construction: the marker is
 * literally this string in brackets, and immutability comes free, because
 * `intentId` and `generation` are both immutable once a generation exists.
 *
 * This is identity, not proof. `attempt.token` remains the separate bearer
 * capability the worker echoes back at preflight — an attemptId is public
 * (it is in the run title) and must never be accepted in its place.
 *
 * @param {{ generation: number | string, intentId: string }} attempt
 * @returns {string}
 */
export function formatAttemptId({ generation, intentId }) {
  return `g${generation}:${intentId}`;
}

/**
 * Recover the attempt an ID names. Returns `undefined` for anything that is
 * not a well-formed attempt ID, including the empty `g:` a hand-triggered
 * `workflow_dispatch` produces.
 *
 * @param {string | undefined | null} attemptId
 * @returns {AttemptMarker | undefined}
 */
export function parseAttemptId(attemptId) {
  const match = attemptId?.match(ATTEMPT_ID_RE);
  return match
    ? { generation: Number(match[1]), intentId: match[2] }
    : undefined;
}

/**
 * Render the marker for a generation.
 *
 * The marker is the attempt ID in brackets — one definition, so the two can
 * never disagree about what identifies an attempt.
 *
 * Accepts strings as well as numbers so the workflow-contract tests can render
 * it with GitHub Actions' own `${{ inputs.broker_generation }}` expressions
 * substituted in, and assert the YAML template against this same function
 * instead of against another copy of the literal.
 *
 * @param {{ generation: number | string, intentId: string }} attempt
 * @returns {string}
 */
export function formatDispatchMarker(attempt) {
  return `[dispatch:${formatAttemptId(attempt)}]`;
}

/**
 * Recover the attempt a run title names.
 *
 * Returns `undefined` for runs that predate the broker rollout and for any run
 * dispatched by hand outside it — a manual `workflow_dispatch` leaves the
 * inputs blank, which GitHub Actions renders as an empty `[dispatch:g:]` that
 * deliberately does not match. Both cases fall back to issue-number
 * attribution only.
 *
 * @param {string | undefined | null} displayTitle
 * @returns {AttemptMarker | undefined}
 */
export function parseDispatchMarker(displayTitle) {
  const match = displayTitle?.match(DISPATCH_MARKER_RE);
  return match
    ? { generation: Number(match[1]), intentId: match[2] }
    : undefined;
}

/**
 * Whether a run title carries this exact generation's marker.
 *
 * @param {string | undefined | null} displayTitle
 * @param {{ generation: number | string, intentId: string }} attempt
 * @returns {boolean}
 */
export function displayTitleMatchesAttempt(displayTitle, attempt) {
  return Boolean(displayTitle?.includes(formatDispatchMarker(attempt)));
}
