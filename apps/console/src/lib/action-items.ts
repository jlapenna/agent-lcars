import { parseTerminalQuickTaskBody } from '@agent-lcars/dispatch-contracts';
import type { GithubAnchorProjection } from '@agent-lcars/orchestrator';

import { maintainerLogin } from './deployment';
import { type WatchedRepo } from './github-client';

export type ActionType =
  | 'needs-human'
  | 'ready-for-agent'
  | 'run-failed'
  | 'review-requested'
  | 'post-deploy-action'
  | 'merge-blocked'
  | 'silent-error';

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
};

const LABELS_SHOWN_AS_ACTION_TYPES = new Set([
  'status:ready-for-agent',
  'status:needs-human',
  'status:post-deploy-action',
]);

function repoFromAnchor(anchor: GithubAnchorProjection['anchor']): WatchedRepo {
  const [owner, name] = anchor.repo.split('/');
  // The orchestrator schema has already accepted the full name. This is a
  // shape conversion only; configuration admission happened at webhook time.
  return { owner: owner as string, name: name as string };
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

export function isDeployWaitOnly(item: ActionItem): boolean {
  return (
    item.actionTypes.length > 0 &&
    item.actionTypes.every((type) => type === 'post-deploy-action')
  );
}
