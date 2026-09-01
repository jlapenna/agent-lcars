/**
 * Attempt identity and the artifact-claim marker.
 *
 * `formatAttemptId` derives an attempt's stable identity from its generation
 * and intent ID; `formatClaimMarker` renders the hidden HTML-comment marker
 * an agent stamps into a deliverable artifact's body to claim it for that
 * attempt. Both are canonical cross-language specs:
 * `apps/runner-autoscaler/runner-image/runtime/verify-outcome.sh`'s bash
 * matcher re-implements `formatClaimMarker`'s format and must be kept in
 * lockstep with it.
 */

/** An attempt's generation and intent ID, accepted as either a number or the
 * literal Actions expression string used to render one before substitution. */
interface AttemptLike {
  generation: number | string;
  intentId: string;
}

/**
 * The attempt's stable identity: `g<generation>:<intentId>`.
 *
 * #645 asks for "one immutable attemptId and workflow-run binding" per
 * attempt. This derives it from the intent and generation rather than minting
 * a fresh random value, for a specific reason: GitHub's API does not return a
 * run's dispatch-time inputs on the run object, so `display_title` is the only
 * channel a bound run and an orchestrator run record actually share. A minted ID would
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
 */
export function formatAttemptId({ generation, intentId }: AttemptLike): string {
  return `g${generation}:${intentId}`;
}

/**
 * The attempt-scoped artifact-claim marker: `<!-- attempt-claim:<attemptId> -->`.
 *
 * #645 Phase 4's exit criterion is "agents cannot certify themselves,
 * unrelated artifacts cannot satisfy a run". Before this marker existed,
 * The native outcome verifier proved a deliverable existed by inference: an
 * open/updated PR referencing the anchor, touched inside this run's time
 * window, under a bot login that is not always unique to one pipeline
 * (codex and opencode both push as `agent-lcars[bot]`). A time window plus a
 * shared identity is not proof: an unrelated PR touched during the window by
 * the same shared login could satisfy a run that produced nothing —
 * confirmed live on jlapenna/agent-lcars#650 generation 9. #815 retired
 * that inference entirely once every live lane adopted this marker;
 * The native outcome verifier now requires it (or the exact claimed no-op
 * result below) on every run.
 *
 * This marker replaces inference with an exact claim for the artifacts that
 * can carry a body: an agent stamps it, hidden in an HTML comment so it does
 * not clutter what a human reviewer sees, into the body of the exact PR,
 * comment, or review it creates (agent-protocol.md #5). The finalizer then
 * looks for this exact string on the artifacts it can reach, rather than
 * reasoning about who touched what during which window.
 *
 * `attemptId` is `formatAttemptId`'s output — there is no second identity
 * here, only a second surface (artifact bodies, not run titles) the same
 * identity gets embedded into.
 *
 * This function is the canonical definition of the claim marker.
 * QueueExecutor's `runtime/verify-outcome.sh` names it as the
 * spec its bash matcher re-implements — keep the two in lockstep.
 */
export function formatClaimMarker(attemptId: string): string {
  return `<!-- attempt-claim:${attemptId} -->`;
}
