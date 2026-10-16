import type { GithubAnchorProjection } from '@agent-lcars/orchestrator';
import type { QualifiedSessionPR, SessionDoc } from '@agent-lcars/telemetry';
import {
  isCanonicalSessionRepository,
  isPublicationCheckout,
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
  /** When `status` is merged: the projection's merge time. */
  mergedAt?: string;
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

/** Successful correlated URLs are lookup hints only. They never establish creation. */
export function sessionPRCandidates(doc: SessionDoc): QualifiedSessionPR[] {
  const refs = [...(doc.deliverables.qualifiedPRs ?? [])];
  if (
    doc.source === 'cli' &&
    doc.agent === 'claude-code' &&
    doc.githubActor &&
    (doc.branch || doc.deliverables.claudeSessionId) &&
    doc.repo
  ) {
    refs.push(...(doc.deliverables.publicationCandidates ?? []));
  }
  return refs.filter(
    (pr) =>
      isCanonicalSessionRepository(pr.repo) &&
      Number.isSafeInteger(pr.number) &&
      pr.number > 0,
  );
}

/** The existing literal-publication boundary is unchanged. Additional evidence
 * comes only from GitHub snapshots plus hook-observed actor/branch context.
 * Missing/legacy/offline facts fail closed; no shell parser is involved. */
export function sessionPRReferences(
  doc: SessionDoc,
  projections: ReadonlyMap<string, GithubAnchorProjection> = new Map(),
): QualifiedSessionPR[] {
  const literal = new Set(
    (doc.deliverables.qualifiedPRs ?? [])
      .filter((pr) => isCanonicalSessionRepository(pr.repo))
      .map((pr) => spendPRKey(pr.repo, pr.number)),
  );
  return sessionPRCandidates(doc).filter((pr) => {
    const key = spendPRKey(pr.repo, pr.number);
    if (literal.has(key)) return true;
    if (doc.source !== 'cli' || !doc.githubActor || !doc.repo) return false;
    const bridge = doc.deliverables.claudeSessionId;
    if (bridge !== undefined && !/^session_[A-Za-z0-9_]{1,124}$/u.test(bridge))
      return false;
    const record = projections.get(key);
    const start = Date.parse(doc.startedAt),
      end = Date.parse(doc.lastActivityAt);
    const created = Date.parse(record?.createdAt ?? '');
    if (
      !record ||
      record.kind !== 'pr' ||
      `${record.anchor.repo.toLowerCase()}#${record.anchor.issue}` !== key ||
      record.author?.toLowerCase() !== doc.githubActor.toLowerCase() ||
      record.headRepository?.toLowerCase() !==
        `${doc.repo.owner}/${doc.repo.name}`.toLowerCase() ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      !Number.isFinite(created) ||
      start > end ||
      created < start ||
      created > end
    )
      return false;
    if (bridge) {
      const observed = Date.parse(doc.observer?.occurredAt ?? '');
      if (
        !record.headSha ||
        !Number.isFinite(observed) ||
        !doc.deliverables.publicationCheckouts?.some(
          (checkout) =>
            isPublicationCheckout(checkout) &&
            checkout.githubActor.toLowerCase() ===
              doc.githubActor!.toLowerCase() &&
            `${checkout.repo.owner}/${checkout.repo.name}`.toLowerCase() ===
              record.headRepository?.toLowerCase() &&
            checkout.branch === record.headRefName &&
            checkout.head === record.headSha &&
            Date.parse(checkout.observedAt) >= created &&
            Date.parse(checkout.observedAt) >= start &&
            Date.parse(checkout.observedAt) <= observed,
        )
      )
        return false;
    } else if (!doc.branch || record.headRefName !== doc.branch) return false;
    // Shared credentials and overlapping windows cannot identify the creating
    // session on their own. Require a positive exact session binding in GitHub's
    // own PR body, never a transcript assertion or an incidental quoted URL.
    const links: string[] = [];
    let fence: { character: string; length: number } | undefined;
    // Comments and fenced examples are not attribution metadata. Unclosed
    // comments/fences consume the rest of the body, conservatively.
    const body = record.body.replace(/<!--[\s\S]*?(?:-->|$)/gu, (comment) =>
      comment.replace(/[^\n]/gu, ' '),
    );
    for (const line of body.split('\n')) {
      const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (delimiter) {
        if (!fence)
          fence = { character: delimiter[1][0], length: delimiter[1].length };
        else if (
          delimiter[1][0] === fence.character &&
          delimiter[1].length >= fence.length &&
          !delimiter[2].trim()
        )
          fence = undefined;
        continue;
      }
      if (fence) continue;
      const link = (
        bridge
          ? /^(?:Claude-Session:[ \t]*)?https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9_-]+)[ \t]*\r?$/u
          : /^Claude-Session:[ \t]*https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9_-]+)[ \t]*\r?$/u
      ).exec(line);
      if (link) links.push(link[1]);
    }
    return (
      doc.agent === 'claude-code' &&
      links.length > 0 &&
      links.every((sessionId) => sessionId === (bridge ?? doc.sessionId))
    );
  });
}

export function sessionPRKeys(
  doc: SessionDoc,
  projections: ReadonlyMap<string, GithubAnchorProjection> = new Map(),
): string[] {
  return [
    ...new Set(
      sessionPRReferences(doc, projections).map((pr) =>
        spendPRKey(pr.repo, pr.number),
      ),
    ),
  ];
}

function unqualifiedReferences(
  doc: SessionDoc,
  projections: ReadonlyMap<string, GithubAnchorProjection>,
): number {
  const qualifiedNumbers = new Set(
    sessionPRReferences(doc, projections).map((pr) => pr.number),
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

function addSession(
  totals: SpendTotals,
  doc: SessionDoc,
  projections: ReadonlyMap<string, GithubAnchorProjection>,
) {
  const cost = docCost(doc);
  totals.sessions++;
  totals.unqualifiedPRReferences += unqualifiedReferences(doc, projections);
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

export type SpendPipelineGrouping = 'adapter' | 'lifecycle';

function pipelineKey(doc: SessionDoc, grouping: SpendPipelineGrouping): string {
  return doc.agent === 'claude-code'
    ? 'claude'
    : doc.agent === 'codex' || doc.agent === 'opencode'
      ? doc.agent
      : grouping === 'lifecycle'
        ? 'unknown'
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
  pipelineGrouping: SpendPipelineGrouping = 'adapter',
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
    addSession(totals, doc, projections);
    const keys = sessionPRKeys(doc, projections);
    if (keys.length === 0) addSession(withoutPR, doc, projections);
    const dimensions = [
      pipelineKey(doc, pipelineGrouping),
      doc.model ?? 'unknown',
      doc.resolvedModel ?? 'unknown',
    ];
    maps.forEach((map, i) => {
      const key = dimensions[i] ?? 'unknown';
      const bucket = map.get(key) ?? {
        ...emptyTotals(),
        prs: new Set<string>(),
      };
      addSession(bucket, doc, projections);
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
        ...(status === 'merged' && projection?.mergedAt
          ? { mergedAt: projection.mergedAt }
          : {}),
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
