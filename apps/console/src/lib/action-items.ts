import { parseTerminalQuickTaskBody } from '@agent-lcars/dispatch-contracts';
import type { GithubAnchorProjection } from '@agent-lcars/orchestrator';
import { z } from 'zod';

import { maintainerLogin } from './deployment';
import { type WatchedRepo } from './github-client';

export type ActionType =
  | 'needs-human'
  | 'ready-for-agent'
  | 'run-failed'
  | 'review-requested'
  | 'post-deploy-action'
  | 'merge-blocked'
  | 'silent-error'
  /** `status:blocked` - waiting on an external dependency or prerequisite.
   *  The label contract keeps it distinct from `needs-human`: nobody has a
   *  decision to make here, so it is never by itself a reason to be in the
   *  Inbox, and a fleet claim on it is deliberate parking, not staleness. */
  | 'blocked';

export type MergeableState =
  'clean' | 'dirty' | 'blocked' | 'unstable' | 'behind' | 'draft' | 'unknown';

export interface SubIssuesSummary {
  total: number;
  completed: number;
}

/**
 * One server-owned GitHub-anchor projection prepared for console rendering.
 * None of these fields is filled by a render-time GitHub listing: webhook
 * deliveries own the snapshot, and Task/Run joins add lifecycle state later.
 */
export interface ActionItem {
  kind: 'issue' | 'pr';
  repo: WatchedRepo;
  number: number;
  title: string;
  body?: string;
  url: string;
  author?: string;
  updatedAt: string;
  actionTypes: ActionType[];
  labels: string[];
  assigneeLogins: string[];
  lastCommentBody?: string;
  lastCommentUrl?: string;
  lastCommentAuthor?: string;
  parentNumber?: number;
  subIssues?: SubIssuesSummary;
  linkedIssueNumbers?: number[];
  draft?: boolean;
  mergeableState?: MergeableState;
  failingChecks?: { name: string; url: string }[];
  ciRunning?: boolean;
  unresolvedReviewThreadCount?: number;
  silentErrorDiagnosis?: string;
  /** The later of the `<!-- agent-lcars:observe-until <ISO instant> -->`
   *  marker found in the body and in the last comment, if either carries
   *  one - see `parseObserveUntilMarker`. An agent or human leaves this
   *  marker when the anchor is legitimately idle because it is waiting on
   *  a scheduled event (a systemd timer, a future check-in) rather than
   *  because nobody has looked at it since dispatch. `claimedIdleReason`
   *  reads it to render "Observing until <date>" instead of "Never
   *  dispatched". */
  observeUntil?: string;
}

export interface ActionItemsResult {
  items: ActionItem[];
}

const ACTION_PRIORITY: Record<ActionType, number> = {
  'needs-human': 0,
  'review-requested': 0,
  'merge-blocked': 0,
  'ready-for-agent': 1,
  'run-failed': 1,
  'silent-error': 1,
  'post-deploy-action': 2,
  blocked: 2,
};

const LABELS_SHOWN_AS_ACTION_TYPES = new Set([
  'status:ready-for-agent',
  'status:needs-human',
  'status:post-deploy-action',
  'status:blocked',
]);

function repoFromAnchor(anchor: GithubAnchorProjection['anchor']): WatchedRepo {
  const [owner, name] = anchor.repo.split('/');
  // The orchestrator schema has already accepted the full name. This is a
  // shape conversion only; configuration admission happened at webhook time.
  return { owner: owner as string, name: name as string };
}

const OBSERVE_UNTIL_MARKER_RE =
  /<!--\s*agent-lcars:observe-until\s+(\S+)\s*-->/;

// Matches the orchestrator's own `isoUtc` convention
// (`libs/orchestrator/src/model.ts`): a full-precision, `Z`-suffixed UTC
// instant only, no numeric offsets. Keeping the marker's format that strict
// (rather than the more permissive `Date.parse`) means it stays exactly
// machine-parseable across every language the fleet's agents run in.
const isoInstant = z.iso.datetime({ offset: false });

/**
 * Parses the `<!-- agent-lcars:observe-until <ISO instant> -->` marker (see
 * docs/github-label-contract.md's "State boundaries" and the agent-protocol
 * reference's Parking section) out of one piece of GitHub text - an issue
 * or PR body, or a comment body. Returns undefined when the text carries no
 * marker, or the captured value is not a valid ISO-8601 UTC instant:
 * garbage in a marker should be silently ignored, not crash the read or
 * invent a bogus date.
 */
export function parseObserveUntilMarker(
  text: string | undefined,
): string | undefined {
  const match = text ? OBSERVE_UNTIL_MARKER_RE.exec(text) : null;
  if (!match) return undefined;
  const parsed = isoInstant.safeParse(match[1]);
  return parsed.success ? parsed.data : undefined;
}

/** The later of two optional `observe-until` markers - a newer comment
 *  extending or renewing the window should win over a stale value left in
 *  the body. Compared numerically (not lexically) so mixed timestamp
 *  precision (with/without fractional seconds) still orders correctly. */
function latestObserveUntil(
  bodyMarker: string | undefined,
  commentMarker: string | undefined,
): string | undefined {
  if (bodyMarker === undefined) return commentMarker;
  if (commentMarker === undefined) return bodyMarker;
  return Date.parse(bodyMarker) >= Date.parse(commentMarker)
    ? bodyMarker
    : commentMarker;
}

export function actionItemFromGithubAnchorProjection(
  projection: GithubAnchorProjection,
  repository?: WatchedRepo,
): ActionItem {
  const actionTypes: ActionType[] = [];
  if (projection.labels.includes('status:ready-for-agent')) {
    actionTypes.push('ready-for-agent');
  }
  if (projection.labels.includes('status:needs-human')) {
    actionTypes.push('needs-human');
  }
  if (projection.labels.includes('status:post-deploy-action')) {
    actionTypes.push('post-deploy-action');
  }
  if (projection.labels.includes('status:blocked')) {
    actionTypes.push('blocked');
  }
  const reviewRequested =
    projection.kind === 'pr' &&
    projection.draft !== true &&
    projection.requestedReviewerLogins?.includes(maintainerLogin());
  if (reviewRequested) actionTypes.push('review-requested');
  const blockedByThreads =
    projection.mergeableState === 'blocked' &&
    (projection.unresolvedReviewThreadCount ?? 0) > 0;
  if (
    projection.kind === 'pr' &&
    !reviewRequested &&
    projection.draft !== true &&
    (projection.mergeableState === 'behind' || blockedByThreads)
  ) {
    actionTypes.push('merge-blocked');
  }
  const failingChecks = (projection.checkRuns ?? []).filter(
    (check) => check.status === 'completed' && check.conclusion === 'failure',
  );
  if (failingChecks.length > 0) {
    actionTypes.push('run-failed');
  }
  const observeUntil = latestObserveUntil(
    parseObserveUntilMarker(projection.body),
    parseObserveUntilMarker(projection.lastComment?.body),
  );
  return {
    kind: projection.kind,
    repo: repository ?? repoFromAnchor(projection.anchor),
    number: projection.anchor.issue,
    title: projection.title,
    body:
      parseTerminalQuickTaskBody(projection.body)?.description ??
      projection.body,
    url: projection.url,
    ...(projection.author === undefined ? {} : { author: projection.author }),
    updatedAt: projection.sourceUpdatedAt,
    actionTypes,
    labels: projection.labels.filter(
      (label) => !LABELS_SHOWN_AS_ACTION_TYPES.has(label),
    ),
    assigneeLogins: projection.assigneeLogins,
    ...(projection.lastComment === undefined
      ? {}
      : {
          lastCommentBody: projection.lastComment.body,
          lastCommentUrl: projection.lastComment.url,
          ...(projection.lastComment.author === undefined
            ? {}
            : { lastCommentAuthor: projection.lastComment.author }),
        }),
    ...(projection.parentNumber === undefined
      ? {}
      : { parentNumber: projection.parentNumber }),
    ...(projection.subIssues === undefined
      ? {}
      : { subIssues: projection.subIssues }),
    ...(projection.linkedIssueNumbers === undefined
      ? {}
      : { linkedIssueNumbers: projection.linkedIssueNumbers }),
    ...(projection.draft === undefined ? {} : { draft: projection.draft }),
    ...(projection.mergeableState === undefined
      ? {}
      : { mergeableState: projection.mergeableState }),
    ...(projection.failingChecks === undefined && failingChecks.length === 0
      ? {}
      : {
          failingChecks:
            projection.failingChecks ??
            failingChecks.map(({ name, url }) => ({ name, url })),
        }),
    ...(projection.ciRunning === undefined && projection.checkRuns === undefined
      ? {}
      : {
          ciRunning:
            projection.ciRunning ??
            projection.checkRuns?.some(
              (check) => check.status !== 'completed',
            ) ??
            false,
        }),
    ...(projection.unresolvedReviewThreadCount === undefined
      ? {}
      : {
          unresolvedReviewThreadCount: projection.unresolvedReviewThreadCount,
        }),
    ...(observeUntil === undefined ? {} : { observeUntil }),
  };
}

export function sortActionItems(items: ActionItem[]): ActionItem[] {
  return [...items].sort((left, right) => {
    const leftPriority =
      left.actionTypes.length === 0
        ? Number.MAX_SAFE_INTEGER
        : Math.min(...left.actionTypes.map((type) => ACTION_PRIORITY[type]));
    const rightPriority =
      right.actionTypes.length === 0
        ? Number.MAX_SAFE_INTEGER
        : Math.min(...right.actionTypes.map((type) => ACTION_PRIORITY[type]));
    return (
      leftPriority - rightPriority ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.url.localeCompare(right.url)
    );
  });
}

/** Action types that describe a wait, not a decision: the item is parked on
 *  something outside the maintainer's hands, so it never lands in the Inbox
 *  on their account alone. Each has its own Bridge section. */
const WAIT_ACTION_TYPES: ReadonlySet<ActionType> = new Set([
  'post-deploy-action',
  'blocked',
]);

export function isWaitOnly(item: ActionItem): boolean {
  return (
    item.actionTypes.length > 0 &&
    item.actionTypes.every((type) => WAIT_ACTION_TYPES.has(type))
  );
}

/** Wait-only, and the wait is a deploy - the Bridge's Waiting-on-Deploy
 *  section. An item that is also blocked belongs to Blocked instead: the
 *  deploy alone would not unstick it. */
export function isDeployWaitOnly(item: ActionItem): boolean {
  return isWaitOnly(item) && !item.actionTypes.includes('blocked');
}

/** Wait-only with `status:blocked` on it - the Bridge's Blocked section. */
export function isBlockedWait(item: ActionItem): boolean {
  return isWaitOnly(item) && item.actionTypes.includes('blocked');
}
