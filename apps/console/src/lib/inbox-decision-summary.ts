import 'server-only';

import { logger } from '@agent-lcars/logging';
import { workRepository } from '@agent-lcars/work';
import { after } from 'next/server';
import { cache } from 'react';

import { type InboxCard, nativeCardText } from '../app/inbox-card';
import { handoffSummaryConfig } from './human-needed-summary';
import { admitInboxSummary, executeInboxSummaries } from './inbox-summary-work';
import { createOrchestratorRuntime } from './orchestrator-runtime';

// Decisions and resume conditions often follow the evidence at the end.
function excerpt(text: string | undefined, limit: number) {
  if (!text || text.length <= limit) return text;
  const omission = '\n[… middle omitted …]\n';
  const head = Math.floor((limit - omission.length) / 2);
  return (
    text.slice(0, head) +
    omission +
    text.slice(-(limit - omission.length - head))
  );
}

/** Source content, not just an item id, keys the cache. A new comment, run,
 * review state or diagnosis must never reuse an earlier decision's summary. */
export function inboxDecisionContext(card: InboxCard): string {
  if ('work' in card) {
    return JSON.stringify({
      kind: card.kind,
      title: card.work.spec.title.slice(0, 500),
      state: card.work.state,
      repo: workRepository(card.work.spec),
      workId: card.work.id,
      updatedAt: card.work.updatedAt,
      runId: card.work.runs.at(-1)?.runId,
      request: excerpt(card.work.spec.description, 3_000),
      handoff: excerpt(nativeCardText(card), 10_000),
    });
  }
  const { item } = card;
  return JSON.stringify({
    kind: item.kind,
    repo: `${item.repo.owner}/${item.repo.name}`,
    number: item.number,
    title: item.title.slice(0, 500),
    updatedAt: item.updatedAt,
    reasons: item.actionTypes,
    body: excerpt(item.body, 5_000),
    latestComment: excerpt(item.lastCommentBody, 6_000),
    latestCommentAuthor: item.lastCommentAuthor,
    mergeableState: item.mergeableState,
    ciRunning: item.ciRunning,
    autoMergeEnabled: item.autoMergeEnabled,
    reviewRequirement: item.reviewRequirement,
    failingChecks: item.failingChecks
      ?.slice(0, 20)
      .map(({ name }) => name.slice(0, 100)),
    unresolvedReviewThreadCount: item.unresolvedReviewThreadCount,
    diagnosis: excerpt(item.silentErrorDiagnosis, 1_000),
    handoffActions: item.humanNeededActions,
  });
}

/** Admission is durable before the response. The framework-owned after callback
 * provides prompt execution; ordinary maintenance recovers interrupted requests. */
export const getInboxDecisionSummary = cache(
  async function getInboxDecisionSummary(
    context: string,
    observedAt: Record<string, string>,
  ) {
    try {
      if (!handoffSummaryConfig()) return undefined;
      const runtime = createOrchestratorRuntime();
      const summary = await admitInboxSummary(runtime, context, observedAt);
      if (summary.pending)
        after(async () => {
          await runtime.drain();
          await executeInboxSummaries(runtime);
        });
      return summary;
    } catch {
      logger.warn(
        'agent-lcars: inbox summary work unavailable; preserving source context',
      );
      return undefined;
    }
  },
);
