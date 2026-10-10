import type { GithubAnchorProjection } from '@agent-lcars/orchestrator';
import type { QualifiedSessionPR, SessionDoc } from '@agent-lcars/telemetry';
import {
  isCanonicalSessionRepository,
  totalTokens,
} from '@agent-lcars/telemetry';

import { docCost, type LedgerTotals } from './session-ledger';

export interface SpendTotals extends LedgerTotals {
  reportedCostUsd: number;
  estimatedCostUsd: number;
  unpricedSessions: number;
  unqualifiedPRReferences: number;
}

export interface SpendBreakdown extends SpendTotals {
  key: string;
  mergedPRs: number;
  unknownPRs: number;
  costPerMergedDeliverableUsd?: number;
}

export interface SpendDeliverable {
  key: string;
  url: string;
  status: 'merged' | 'unmerged' | 'unknown';
  /** Equal shares across a session's unique repository-qualified PR refs.
   * Includes unknown/unmerged shares; never charges a session twice. */
  reportedCostUsd: number;
  estimatedCostUsd: number;
  unpricedShares: number;
  sessions: number;
}

export interface SessionSpend {
  totals: SpendTotals;
  byPipeline: SpendBreakdown[];
  byRequestedModel: SpendBreakdown[];
  byResolvedModel: SpendBreakdown[];
  deliverables: SpendDeliverable[];
  mergedPRs: number;
  unknownPRs: number;
  unmergedPRs: number;
  costPerMergedDeliverableUsd?: number;
  withoutPR: SpendTotals;
  coverageLimited: boolean;
}

export const spendPRKey = (repo: { owner: string; name: string }, n: number) =>
  `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}#${n}`;

export function sessionPRReferences(doc: SessionDoc): QualifiedSessionPR[] {
  return (doc.deliverables.qualifiedPRs ?? []).filter(
    (pr) =>
      isCanonicalSessionRepository(pr.repo) &&
      Number.isSafeInteger(pr.number) &&
      pr.number > 0,
  );
}

export function sessionPRKeys(doc: SessionDoc): string[] {
  return [
    ...new Set(
      sessionPRReferences(doc).map((pr) => spendPRKey(pr.repo, pr.number)),
    ),
  ];
}

function unqualifiedReferences(doc: SessionDoc): number {
  const qualifiedNumbers = new Set(
    (doc.deliverables.qualifiedPRs ?? []).map((pr) => pr.number),
  );
  return [...new Set(doc.deliverables.prNumbers)].filter(
    (n) => !qualifiedNumbers.has(n),
  ).length;
}

function emptyTotals(): SpendTotals {
  return {
    sessions: 0,
    turns: 0,
    tokens: 0,
    reportedCostUsd: 0,
    estimatedCostUsd: 0,
    unpricedSessions: 0,
    unqualifiedPRReferences: 0,
  };
}

function addSession(totals: SpendTotals, doc: SessionDoc) {
  const cost = docCost(doc);
  totals.sessions++;
  totals.unqualifiedPRReferences += unqualifiedReferences(doc);
  totals.turns += doc.turns;
  totals.tokens += totalTokens(doc.tokens);
  if (cost.costUsd === undefined) totals.unpricedSessions++;
  else {
    totals.costUsd = (totals.costUsd ?? 0) + cost.costUsd;
    if (cost.estimated) {
      totals.estimatedCostUsd += cost.costUsd;
      totals.costEstimated = true;
    } else totals.reportedCostUsd += cost.costUsd;
  }
}

function pipelineKey(doc: SessionDoc): string {
  return doc.agent === 'claude-code'
    ? 'claude'
    : doc.agent === 'codex' || doc.agent === 'opencode'
      ? doc.agent
      : `other: ${doc.agent}`;
}

type Bucket = SpendTotals & { prs: Set<string> };

/** Whole cumulative session spend for the caller's exact selected docs.
 * Denominator is unique known-merged PRs referenced by those sessions,
 * regardless of merge date. Unknown projections never count as merges. */
export function aggregateSessionSpend(
  docs: SessionDoc[],
  projections: ReadonlyMap<string, GithubAnchorProjection> = new Map(),
  coverageLimited = false,
): SessionSpend {
  const totals = emptyTotals(),
    withoutPR = emptyTotals();
  const maps = [
    new Map<string, Bucket>(),
    new Map<string, Bucket>(),
    new Map<string, Bucket>(),
  ] as const;
  const deliverables = new Map<string, SpendDeliverable>();

  for (const doc of docs) {
    addSession(totals, doc);
    const keys = sessionPRKeys(doc);
    if (keys.length === 0) addSession(withoutPR, doc);
    const dimensions = [
      pipelineKey(doc),
      doc.model ?? 'unknown',
      doc.resolvedModel ?? 'unknown',
    ];
    maps.forEach((map, i) => {
      const key = dimensions[i] ?? 'unknown';
      const bucket = map.get(key) ?? {
        ...emptyTotals(),
        prs: new Set<string>(),
      };
      addSession(bucket, doc);
      keys.forEach((pr) => bucket.prs.add(pr));
      map.set(key, bucket);
    });

    const cost = docCost(doc);
    for (const key of keys) {
      const projection = projections.get(key);
      const identityMatches =
        projection !== undefined &&
        `${projection.anchor.repo.toLowerCase()}#${projection.anchor.issue}` ===
          key &&
        projection.kind === 'pr';
      const status =
        !identityMatches || projection.mergedAt === undefined
          ? 'unknown'
          : projection.mergedAt === null
            ? 'unmerged'
            : projection.state === 'closed' &&
                Number.isFinite(Date.parse(projection.mergedAt))
              ? 'merged'
              : 'unknown';
      const [repository, number] = key.split('#');
      const row = deliverables.get(key) ?? {
        key,
        status,
        url: `https://github.com/${repository}/pull/${number}`,
        reportedCostUsd: 0,
        estimatedCostUsd: 0,
        unpricedShares: 0,
        sessions: 0,
      };
      row.sessions++;
      if (cost.costUsd === undefined) row.unpricedShares += 1 / keys.length;
      else if (cost.estimated)
        row.estimatedCostUsd += cost.costUsd / keys.length;
      else row.reportedCostUsd += cost.costUsd / keys.length;
      deliverables.set(key, row);
    }
  }

  function rows(map: Map<string, Bucket>): SpendBreakdown[] {
    return [...map]
      .map(([key, { prs, ...sum }]) => {
        const mergedPRs = [...prs].filter(
          (pr) => deliverables.get(pr)?.status === 'merged',
        ).length;
        const unknownPRs = [...prs].filter(
          (pr) => deliverables.get(pr)?.status === 'unknown',
        ).length;
        return {
          key,
          ...sum,
          mergedPRs,
          unknownPRs,
          ...(mergedPRs > 0 && sum.costUsd !== undefined
            ? { costPerMergedDeliverableUsd: sum.costUsd / mergedPRs }
            : {}),
        };
      })
      .sort(
        (a, b) =>
          (b.costUsd ?? -1) - (a.costUsd ?? -1) || a.key.localeCompare(b.key),
      );
  }

  const prRows = [...deliverables.values()].sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  const mergedPRs = prRows.filter((row) => row.status === 'merged').length;
  return {
    totals,
    withoutPR,
    coverageLimited,
    byPipeline: rows(maps[0]),
    byRequestedModel: rows(maps[1]),
    byResolvedModel: rows(maps[2]),
    deliverables: prRows,
    mergedPRs,
    unknownPRs: prRows.filter((row) => row.status === 'unknown').length,
    unmergedPRs: prRows.filter((row) => row.status === 'unmerged').length,
    ...(mergedPRs > 0 && totals.costUsd !== undefined
      ? { costPerMergedDeliverableUsd: totals.costUsd / mergedPRs }
      : {}),
  };
}

export type CostBudget =
  | { state: 'unconfigured' }
  | { state: 'invalid' }
  | { state: 'configured'; limitUsd: number; warningPercent: number };

export function parseCostBudget(limit?: string, warning?: string): CostBudget {
  if (limit === undefined || limit.trim() === '')
    return { state: 'unconfigured' };
  const limitUsd = Number(limit),
    warningPercent = warning === undefined ? 80 : Number(warning);
  if (
    !Number.isFinite(limitUsd) ||
    limitUsd <= 0 ||
    !Number.isFinite(warningPercent) ||
    warningPercent <= 0 ||
    warningPercent >= 100
  )
    return { state: 'invalid' };
  return { state: 'configured', limitUsd, warningPercent };
}

export function assessCostBudget(
  spend: SessionSpend,
  budget: CostBudget,
): string {
  if (budget.state === 'unconfigured') return 'No budget configured';
  if (budget.state === 'invalid') return 'Budget configuration invalid';
  const known = spend.totals.costUsd ?? 0;
  if (known >= budget.limitUsd) return 'At or above budget';
  if (known >= (budget.limitUsd * budget.warningPercent) / 100)
    return 'Near budget';
  if (spend.coverageLimited || spend.totals.unpricedSessions > 0)
    return 'Cannot assess: incomplete spend';
  return 'Below warning threshold';
}
