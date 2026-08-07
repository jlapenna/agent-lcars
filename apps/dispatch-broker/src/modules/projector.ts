/**
 * The projector (#645 Phase 4 §5): converges GitHub-facing, human-visible
 * state — comments, labels, assignees — from the controller/finalizer's
 * already-decided truth. It does not decide dispatch or outcome; it only
 * makes GitHub agree with a decision made elsewhere.
 *
 * §5's "must not" list is the spec this module is built against:
 *
 *   - must not change an attempt outcome because a comment failed;
 *   - must not use assignees or labels as control-plane authority;
 *   - must not map every infrastructure failure to needs-human.
 *
 * Structural protection, not convention (the exit criterion is "reporting
 * failure cannot alter outcome truth"): this file imports nothing from
 * `../broker.js` — none of `beginDispatch`/`bindRun`/`completeRun`/
 * `markDispatchRejected`/`markDispatchUnknown`/`observeCompletion`/
 * `acceptIntent`/`applyAnchorControl`, the only functions in this codebase
 * that can write `DispatchLedger.generations`, `.sources`, or `.control`,
 * are reachable from here at all. The one ledger-mutating export below,
 * `recordProjectionStatus`, imports only `mutate` from `./ledger-core.js`
 * (the same primitive scheduler.ts/intent.ts build on) and assigns to
 * exactly one field, `ledger.projection`. There is therefore no code path
 * through this module — success, failure, or partial completion — that
 * reaches `generations`/`sources`/`control` today.
 *
 * Be precise about how strong that is. The import list rules out every
 * *transition*, which is the part a reviewer can check at a glance. It
 * does not make the field write impossible: `mutate` is a generic
 * primitive, so someone could assign to `generations` inside the callback
 * above without adding an import. That would be a visible, deliberate edit
 * to this file rather than an accident of call depth, which is the
 * property worth having — but calling it "cannot" would overclaim. A
 * reviewer confirms the transitions from the import list, and this one
 * callback by reading it, without tracing
 * control flow.
 *
 * Failure recording is deliberately NOT reimplemented here. main.ts's
 * `runPhase` already does exactly this job (classify via `classifyFailure`,
 * record via `addAnomaly` — itself anomalies-only, never generations — log,
 * rethrow unchanged) for every other phase; callers wrap a projector call
 * the same way, e.g. `runPhase(ledgerContext, 'reporting', () =>
 * projectNeedsHumanPark(...), 'projector')`. Building a second, parallel
 * try/classify/record/rethrow wrapper here would be exactly the "inventing
 * a parallel mechanism" #645 Phase 4's build notes warn against.
 */

import type {
  DispatchLedger,
  FailureClassification,
  LedgerTaskRef,
} from '@agent-lcars/dispatch-contracts';
import { needsMaintainer } from '@agent-lcars/dispatch-contracts';

import {
  createGitHubApi,
  ensureNeedsHumanParked,
  listAll,
  removeIssueLabel,
  repositoryPath,
} from '../github-api.js';
import { mutate } from './ledger-core.js';

/** The projector's own GitHub client shape — derived from
 *  `createGitHubApi`'s real return type rather than a third hand-copied
 *  duplicate of `{ request, requestOk }` (github-api.ts and main.ts each
 *  already carry one; see main.ts's own `GitHubApiClient` for why every
 *  file names the shape it needs rather than sharing an export). */
export type GitHubApiClient = ReturnType<typeof createGitHubApi>;

/** The minimal comment shape `projectComment` reads/writes — the same two
 *  fields broker.ts's ledger comment handling reads off the identical
 *  `GET/POST/PATCH .../issues/comments` endpoints. */
interface ProjectedComment {
  id: number;
  body: string;
}

export interface ProjectCommentResult {
  id: number;
  action: 'created' | 'updated';
}

function projectionMarker(kind: string, key: string): string {
  return `<!-- agent-lcars:projection:${kind}:${key} -->`;
}

/**
 * Idempotent comment upsert, generalizing the ledger comment's own marker +
 * find-then-patch shape (broker.ts's `loadLedger`/`saveLedger`, keyed on
 * `LEDGER_MARKER`) to any projector-owned comment.
 *
 * The idempotence key is the pair `(kind, key)`, embedded verbatim as an
 * HTML comment marker in the rendered body: `kind` names which projection
 * this is (e.g. `'needs-human-explanation'`), and `key` is the stable
 * identity within that kind — typically an attemptId — that makes an
 * at-least-once retry of the SAME projection find and patch the SAME
 * comment instead of creating a second one. This is what #645 Phase 4 means
 * by "idempotence keyed on something stable": the marker, not the request,
 * is the identity a retry converges on.
 *
 * `render` receives the marker so every caller embeds it verbatim rather
 * than reconstructing it by hand, the same discipline
 * `renderLedgerComment`/`LEDGER_MARKER` already follow.
 *
 * More than one comment carrying the same marker means either a prior
 * projection raced with itself outside this function's own find-then-patch
 * window, or the comment was tampered with — either way, guessing which one
 * is "the" projection comment would silently pick one arbitrarily, so this
 * throws instead (same posture as `loadLedger`'s "duplicate dispatch ledger
 * comments" check).
 */
export async function projectComment(
  api: GitHubApiClient,
  task: LedgerTaskRef,
  kind: string,
  key: string,
  render: (marker: string) => string,
): Promise<ProjectCommentResult> {
  const marker = projectionMarker(kind, key);
  const root = repositoryPath(task);
  const comments = await listAll<ProjectedComment>(
    api,
    `${root}/issues/${task.issue}/comments`,
  );
  const existing = comments.filter((comment) => comment.body?.includes(marker));
  if (existing.length > 1) {
    throw new Error(
      `Duplicate ${kind} projection comment on issue #${task.issue} for key ${key}`,
    );
  }
  const body = render(marker);
  if (existing.length === 1) {
    const updated = await api.requestOk<ProjectedComment>(
      `${root}/issues/comments/${existing[0].id}`,
      { method: 'PATCH', body: { body } },
    );
    return { id: updated.id, action: 'updated' };
  }
  const created = await api.requestOk<ProjectedComment>(
    `${root}/issues/${task.issue}/comments`,
    { method: 'POST', body: { body } },
  );
  return { id: created.id, action: 'created' };
}

export interface ProjectNeedsHumanResult {
  /** Whether `status:needs-human` (and the maintainer assignee) was
   *  actually applied. `false` covers two different reasons, distinguished
   *  by nothing further being needed either way: `needsMaintainer(failure)`
   *  was false (the failure stays owned by its own system), or the ledger
   *  already had the label. */
  parked: boolean;
}

/**
 * The projector's needs-human decision, and nothing else. `needsMaintainer`
 * (`@agent-lcars/dispatch-contracts`) is the ONE place that policy lives —
 * this function calls it rather than re-deriving any part of it (e.g.
 * branching on `failure.retryDisposition`/`failure.reason` directly here
 * would be exactly the "local re-derivation" #645 Phase 4 warns against). A
 * retryable runner or provider incident (`immediate`/`backoff`/
 * `after_health_change`) is therefore never parked here, and stays owned by
 * its own system as #645 §5 requires.
 *
 * `ensureNeedsHumanParked` itself (github-api.ts) is untouched: its
 * verify-then-decide handling of a `gh`/REST parse hiccup that actually
 * landed (#346) is real idempotence, called straight through unchanged, not
 * reimplemented.
 */
export async function projectNeedsHumanPark(
  api: GitHubApiClient,
  task: LedgerTaskRef,
  maintainer: string,
  failure: FailureClassification,
): Promise<ProjectNeedsHumanResult> {
  if (!needsMaintainer(failure)) return { parked: false };
  await ensureNeedsHumanParked(api, task, maintainer);
  return { parked: true };
}

// Re-exported under the projector's own surface: #645 Phase 4 names stale
// `agent:*` label cleanup as one of the GitHub-facing writes that belongs
// here. `removeIssueLabel` itself (github-api.ts) is unchanged — its 404-
// tolerant "already gone counts as done" idempotence is exactly the shape
// this module's own comment/label primitives follow, so it is re-exported
// rather than wrapped. github-api.ts's own export of it is also kept (see
// its export list) so every existing importer keeps working unchanged.
export { removeIssueLabel };

/**
 * Record a convergence checkpoint. `desiredRevision` is the ledger revision
 * this attempt targeted — read BEFORE `mutate` bumps it for this write
 * itself, so it names the state the projector was actually converging
 * toward, not the write this call is about to make. `observedRevision`
 * moves to match it on success (`converged: true`); on failure it holds at
 * whatever the last successful convergence reached (0 if there has never
 * been one), which is what makes `state` derivable from the two numbers
 * alone rather than a third stored flag.
 *
 * Pure ledger mutation, no GitHub I/O — callers decide separately whether
 * and when to persist the ledger (`saveLedger`), the same division every
 * other ledger-core transition in this codebase already keeps.
 */
export function recordProjectionStatus(
  ledger: DispatchLedger,
  converged: boolean,
  now: string = new Date().toISOString(),
): DispatchLedger {
  const desiredRevision = ledger.revision;
  const observedRevision = converged
    ? desiredRevision
    : (ledger.projection?.observedRevision ?? 0);
  return mutate(ledger, now, () => {
    ledger.projection = {
      desiredRevision,
      observedRevision,
      state: converged
        ? 'converged'
        : observedRevision > 0
          ? 'diverged'
          : 'pending',
      observedAt: now,
    };
  });
}
