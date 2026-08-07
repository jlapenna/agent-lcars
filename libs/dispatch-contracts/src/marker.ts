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

export interface AttemptMarker {
  generation: number;
  intentId: string;
}

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
 */
export function formatAttemptId({ generation, intentId }: AttemptLike): string {
  return `g${generation}:${intentId}`;
}

/**
 * Recover the attempt an ID names. Returns `undefined` for anything that is
 * not a well-formed attempt ID, including the empty `g:` a hand-triggered
 * `workflow_dispatch` produces.
 */
export function parseAttemptId(
  attemptId: string | undefined | null,
): AttemptMarker | undefined {
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
 */
export function formatDispatchMarker(attempt: AttemptLike): string {
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
 */
export function parseDispatchMarker(
  displayTitle: string | undefined | null,
): AttemptMarker | undefined {
  const match = displayTitle?.match(DISPATCH_MARKER_RE);
  return match
    ? { generation: Number(match[1]), intentId: match[2] }
    : undefined;
}

/**
 * Whether a run title carries this exact generation's marker.
 */
export function displayTitleMatchesAttempt(
  displayTitle: string | undefined | null,
  attempt: AttemptLike,
): boolean {
  return Boolean(displayTitle?.includes(formatDispatchMarker(attempt)));
}

/**
 * The router run-name marker: `[router-group:<repositoryId>:<issue>]`.
 *
 * `agent-router.yml`'s own `run-name:` embeds this for every trigger type
 * (issues, issue_comment, pull_request, workflow_dispatch) unconditionally.
 * Unlike the dispatch marker above -- which only ever reaches a run title
 * once a worker workflow actually starts -- this one does not depend on any
 * job running or any endpoint self-reporting anything: GitHub Actions
 * evaluates `run-name:` for every run at trigger time, identically
 * regardless of what fired it.
 *
 * That is what makes it usable as the join key for
 * `findConflictingRouterRun` (`.github/actions/dispatch-broker/
 * github-api.mjs`, #545): two concurrent router runs can each see the
 * OTHER's marker on the reliable run-LISTING response (`display_title` is
 * returned inline for every run in a list -- see `findRunsForGeneration`'s
 * identical reliance on that field) without either one ever inspecting its
 * OWN `.../concurrency_groups` sub-resource, the endpoint issues #348/#545
 * found unreliable across every trigger type sampled, at rates from ~17% to
 * 100% depending on trigger.
 *
 * Derived from the same two inputs `brokerConcurrencyGroup`
 * (github-api.mjs) derives its own group name from -- a TaskRef's
 * `repositoryId` and `issue` -- but deliberately not from
 * `brokerConcurrencyGroup`'s literal string itself: that format is owned by
 * the broker action, not by this shared, dependency-free package, and this
 * repo already carries one independent, lower-cased re-implementation of it
 * (main.mjs's `normalize` step output). Pinning a second format to that same
 * string would just add a third copy of it. This marker's format is defined
 * exactly once, here.
 */
const ROUTER_GROUP_MARKER_RE = /\[router-group:(\d+):(\d+)\]/u;

export interface RouterGroupIdentity {
  repositoryId: number;
  issue: number;
}

/**
 * Render the marker `agent-router.yml`'s `run-name:` embeds.
 *
 * Accepts strings as well as numbers so `workflow-contract.test.mjs` can
 * render it with GitHub Actions' own `${{ github.repository_id }}` /
 * `${{ github.event.issue.number || github.event.pull_request.number ||
 * inputs.issue }}` expressions substituted in, and assert the YAML against
 * this same function instead of against a second copy of the literal --
 * exactly as `formatDispatchMarker` already does for worker `run-name:`
 * templates.
 */
export function formatRouterGroupMarker({
  repositoryId,
  issue,
}: {
  repositoryId: number | string;
  issue: number | string;
}): string {
  return `[router-group:${repositoryId}:${issue}]`;
}

/**
 * Recover a router run's group identity from its `display_title`.
 *
 * Returns `undefined` for a title with no marker at all -- a run that
 * predates this change, or (defensively) a malformed one -- so a caller can
 * tell "no marker" apart from "marker present but for a different task"
 * rather than treating both the same.
 */
export function parseRouterGroupMarker(
  displayTitle: string | undefined | null,
): RouterGroupIdentity | undefined {
  const match = displayTitle?.match(ROUTER_GROUP_MARKER_RE);
  return match
    ? { repositoryId: Number(match[1]), issue: Number(match[2]) }
    : undefined;
}

/**
 * The attempt-scoped artifact-claim marker: `<!-- attempt-claim:<attemptId> -->`.
 *
 * #645 Phase 4's exit criterion is "agents cannot certify themselves,
 * unrelated artifacts cannot satisfy a run". Today, `verify-deliverable.sh`
 * proves a deliverable exists by inference: an open/updated PR referencing
 * the anchor, touched inside this run's time window, under a bot login that
 * is not always unique to one pipeline (codex and opencode both push as
 * `agent-lcars[bot]`, an acknowledged limitation — see
 * `excludedPullRequestAuthors`). A time window plus a shared identity is not
 * proof: an unrelated PR touched during the window by the same shared login
 * can satisfy a run that produced nothing.
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
 */
const CLAIM_MARKER_RE = /<!--\s*attempt-claim:([A-Za-z0-9._:-]+)\s*-->/u;

/**
 * The kinds of artifact a claim can name — the deliverable shapes
 * agent-protocol.md #5 recognizes as a visible dispatch outcome that can
 * carry a body, minus the "park" case (a park is a `status:needs-human`
 * label/assignee pair, not an artifact a marker can be stamped into).
 */
export type ClaimArtifactType = 'pr' | 'comment' | 'review' | 'close';

/**
 * #645's Shared contracts section: "AgentResultClaim: attempt ID and exact
 * artifact type/ID/URL." Worker runtime emits these; the finalizer treats
 * them as untrusted until it independently re-fetches the named artifact and
 * confirms the marker is actually present on it — this type alone proves
 * nothing, it is what gets validated.
 */
export interface AgentResultClaim {
  attemptId: string;
  artifactType: ClaimArtifactType;
  /** The artifact's own identifier — a PR/issue number, a comment ID, or a
   *  review ID — always as a string so a numeric and a URL-shaped identifier
   *  share one field type. */
  artifactId: string;
  /** The artifact's `html_url`, when known. */
  artifactUrl?: string;
}

/**
 * Render the marker for an attempt.
 */
export function formatClaimMarker(attemptId: string): string {
  return `<!-- attempt-claim:${attemptId} -->`;
}

/**
 * Recover the attempt ID a piece of artifact text claims, if any.
 *
 * Returns `undefined` for text with no marker at all, so a caller can tell
 * "no claim" apart from "claim present but for some other attempt" instead
 * of collapsing both to the same falsy result.
 */
export function parseClaimMarker(
  text: string | undefined | null,
): string | undefined {
  return text?.match(CLAIM_MARKER_RE)?.[1];
}

/**
 * Whether artifact text carries THIS exact attempt's marker — not merely a
 * marker for some other attempt. This is the whole point of the exact-claim
 * check: a marker naming a different attempt must not satisfy this one.
 */
export function textCarriesClaim(
  text: string | undefined | null,
  attemptId: string,
): boolean {
  return Boolean(text?.includes(formatClaimMarker(attemptId)));
}
