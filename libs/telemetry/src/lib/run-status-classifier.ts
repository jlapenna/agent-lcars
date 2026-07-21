import { SessionResult } from './types';

/**
 * GitHub Actions run status/conclusion — mirrors the console's own
 * `AgentRunStatus`/`AgentRunConclusion` (apps/console/src/lib/
 * agent-activity.ts) but redeclared here rather than imported: this lib is
 * app-agnostic (libs must not depend on apps), and the two unions are
 * structurally identical so no cast is needed at the call site.
 */
export type RunStatus = 'queued' | 'running' | 'completed';
export type RunConclusion = 'success' | 'failure' | 'cancelled' | 'other';

export interface ClassifierRunInput {
  status: RunStatus;
  conclusion?: RunConclusion;
  /** Queued: seconds waiting for a runner. Running: seconds since start.
   * Completed: total run duration. Matches `AgentRun.elapsedSeconds`. */
  elapsedSeconds: number;
  /** The workflow's `timeout-minutes` kill budget (90 for claude.yml and
   * opencode.yml as of #3024) — pass the caller's own constant; this module
   * doesn't hardcode it so it can't silently drift from the workflow files
   * it's meant to explain. */
  timeoutMinutes: number;
}

/**
 * The subset of a joined session doc/summary the classifier needs — a
 * structural type so callers can pass either a `SessionSummary` or a
 * `SessionDoc` (both carry these fields) without this module depending on
 * the source-discriminated `SessionDoc` union.
 */
export interface ClassifierSessionInput {
  turns: number;
  result?: SessionResult;
  totalCostUsd?: number;
}

export type RunStatusClassification =
  'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled' | 'silent-error';

export interface RunStatusClassifierResult {
  status: RunStatusClassification;
  /** Short human-readable sentence naming the known failure signature
   * (expired token, max-turns exhaustion, timeout kill, a crash, or a
   * "success" that shows essentially no session-provable work). Undefined
   * when there's nothing more specific to say than the status itself —
   * including whenever no session doc was joined (PRD user story 16: runner
   * sessions may not be flowing yet, or the store may be unreachable). */
  diagnosis?: string;
}

/**
 * A cancelled run at (or near) the timeout budget almost certainly WAS the
 * timeout kill, not a manual/API cancel — the workflow's kill posts nothing
 * to the issue by itself, so elapsed-time-vs-budget is the only signal
 * telling the two apart. This is the exact heuristic Phase 0 already shipped
 * in apps/console/src/app/agent-activity-panel.tsx
 * (`isLikelyTimeout`/`LIKELY_TIMEOUT_FRACTION`) — moved here so that file can
 * delegate to this single source of truth instead of re-declaring it.
 */
export const LIKELY_TIMEOUT_FRACTION = 0.95;

const MAX_TURNS_DIAGNOSIS =
  'Hit the max-turns budget mid-task (error_max_turns) — likely made real progress but did not finish; check its last comment for a takeover/resume command.';
const AUTH_ERROR_DIAGNOSIS =
  'Session errored during startup with ~$0 cost — looks like an expired or invalid OAuth token/API key.';
const CRASH_DIAGNOSIS =
  'Session errored during execution (not a startup/auth failure, not max-turns) — check the run log for details.';
// A `success` conclusion has ALREADY passed two server-side gates in
// claude.yml before the console ever sees it: "Verify Claude run status"
// (fails the job on an is_error/$0 startup crash) and "Verify a deliverable
// exists" (fails the job unless GitHub state shows a PR/commit/closed-issue/
// human-needed label, #2497). So this diagnosis is deliberately NOT a
// "no PR or commit" re-check of GitHub state — that would just re-litigate
// a gate that already ran, with worse data (a comment-only reply, a
// playbook run with no announce comment, or a session merely reading past
// comments would all false-positive on transcript text). Its job is
// narrower: catch the cases those GitHub-state gates can't see at all,
// because they're facts about the SESSION, not the repo — an error result
// the job step didn't propagate, or a session that did essentially nothing
// (zero turns, or zero cost across at most one turn) despite exiting clean.
const ZERO_USAGE_DIAGNOSIS =
  'GitHub reported success, but the session shows a failure signature or recorded essentially no work (zero turns, or zero cost across at most one turn) — worth a second look despite the green conclusion.';

function isMaxTurnsSignature(session: ClassifierSessionInput): boolean {
  return session.result?.subtype === 'error_max_turns';
}

function isAuthErrorSignature(session: ClassifierSessionInput): boolean {
  return session.result?.isError === true && (session.totalCostUsd ?? 0) === 0;
}

function isCrashSignature(session: ClassifierSessionInput): boolean {
  return session.result?.isError === true && !isAuthErrorSignature(session);
}

/** Checks the session-level error signatures only (max-turns / auth /
 * crash) — used for the failure/cancelled branches below, where a session
 * error is a genuine finding worth naming. */
function diagnoseSessionError(
  session?: ClassifierSessionInput,
): string | undefined {
  if (!session) return undefined;
  if (isMaxTurnsSignature(session)) return MAX_TURNS_DIAGNOSIS;
  if (isAuthErrorSignature(session)) return AUTH_ERROR_DIAGNOSIS;
  if (isCrashSignature(session)) return CRASH_DIAGNOSIS;
  return undefined;
}

/**
 * True only for session-provable anomalies under a `success` conclusion —
 * every field involved is either always-present on a joined session
 * (`turns`) or explicitly checked for presence before comparing
 * (`totalCostUsd`), so an absent/undefined field never flags on its own
 * (PRD user story 16: a bare summary doc may lack cost data entirely, and
 * that must render as "succeeded", not as a false alarm):
 *
 * - `result.isError === true` — the CLI itself reported an error (crash,
 *   auth failure, or max-turns exhaustion; see the sibling checks above),
 *   yet the job step still reported success.
 * - `turns === 0` — the session recorded no assistant turns at all.
 * - `totalCostUsd === 0` (only when the field is PRESENT) with `turns <= 1`
 *   — essentially free, essentially turn-less: consistent with a crash
 *   before real work started rather than a genuine no-op reply (a real
 *   reply still costs at least one full turn).
 */
function hasZeroWorkSignature(session: ClassifierSessionInput): boolean {
  if (session.result?.isError === true) return true;
  if (session.turns === 0) return true;
  if (session.totalCostUsd !== undefined && session.totalCostUsd === 0) {
    return session.turns <= 1;
  }
  return false;
}

/** True when a completed, cancelled run's elapsed time is close enough to
 * the wall-clock budget that it was almost certainly killed by it. */
export function isLikelyTimeoutRun(run: ClassifierRunInput): boolean {
  return (
    run.conclusion === 'cancelled' &&
    run.elapsedSeconds >= run.timeoutMinutes * 60 * LIKELY_TIMEOUT_FRACTION
  );
}

/**
 * Classifies a GitHub Actions run's outcome using its own conclusion/timing
 * plus (when available) the joined session telemetry that conclusion alone
 * can't see through — the known incident signatures the PRD calls out:
 * expired OAuth token, max-turns exhaustion, and a timeout kill mislabeled
 * by a bare `cancelled` conclusion. A `success`-with-no-deliverable check is
 * deliberately NOT one of them — see `ZERO_USAGE_DIAGNOSIS`'s doc comment
 * for why claude.yml's own server-side gates already cover that ground with
 * better data than this classifier has access to.
 *
 * Pure and total: every branch is covered, including an absent `session`
 * (the join can't happen yet, or ever, for a given run) and an unexpected
 * `conclusion` (defensively treated as `failed` — not expected to occur via
 * the console's own fetchers, since `fetchRecentRuns` only ever queries
 * success/failure/cancelled and `fetchLiveRuns` filters out completed runs
 * before a conclusion is read at all).
 */
export function classifyRunStatus(
  run: ClassifierRunInput,
  session?: ClassifierSessionInput,
): RunStatusClassifierResult {
  if (run.status !== 'completed') {
    return { status: 'running' };
  }

  if (isLikelyTimeoutRun(run)) {
    return {
      status: 'timeout',
      diagnosis: `Cancelled at ≥${Math.round(LIKELY_TIMEOUT_FRACTION * 100)}% of the ${run.timeoutMinutes}-minute wall-clock budget — almost certainly a timeout kill, not a manual cancel.`,
    };
  }

  if (run.conclusion === 'cancelled') {
    return { status: 'cancelled', diagnosis: diagnoseSessionError(session) };
  }

  if (run.conclusion === 'failure') {
    return { status: 'failed', diagnosis: diagnoseSessionError(session) };
  }

  if (run.conclusion === 'success') {
    if (session && hasZeroWorkSignature(session)) {
      return { status: 'silent-error', diagnosis: ZERO_USAGE_DIAGNOSIS };
    }
    return { status: 'succeeded' };
  }

  return { status: 'failed', diagnosis: diagnoseSessionError(session) };
}
