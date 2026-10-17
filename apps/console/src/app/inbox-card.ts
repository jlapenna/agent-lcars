import type { WorkSummary } from '@agent-lcars/work/derive';
import type { ReactNode } from 'react';

import { repoItemKey } from '../lib/watched-repo';
import type { BoardCard } from './board-card';
import { actionTypeMeta, queueReasonFor } from './queue-reason';

export interface NativeDecisionCard {
  work: WorkSummary & { anchor: { workId: string } };
  /** `decision` waits on a human answer; `report` is a finished read-only
   * result (#2845) shown until dismissed or older than the report window. */
  kind: 'decision' | 'report';
  /** Listed in the Inbox. False only for a selected item that no longer
   * waits on anyone, kept so its open detail pane does not vanish. */
  queued: boolean;
  canReply: boolean;
  /** The parked question or report rendered as Markdown on the server, so
   * the interactive detail pane does not carry the parser. */
  question?: ReactNode;
}

/** Dismissing a report snoozes it for the longest snooze. A finished report
 * stays in the Inbox exactly that long after it settles, so a dismissed one
 * ages out before the snooze could expire and never returns. */
export const REPORT_DISMISS_MINUTES = 10_080;
export const REPORT_INBOX_WINDOW_MS = REPORT_DISMISS_MINUTES * 60_000;

type NativeWork = Pick<WorkSummary, 'state' | 'runs'>;

/** The run whose final message is a done item's report, if it has one. */
export function nativeReportRun(work: NativeWork) {
  const latest = work.runs.at(-1);
  return work.state === 'done' && latest?.result?.summary === 'report'
    ? latest
    : undefined;
}

export type InboxCard = BoardCard | NativeDecisionCard;

/** The agent a decision belongs to: a native item's pipeline, or the
 * GitHub anchor's `agent:*` label. */
export function inboxCardAgent(card: InboxCard): string | undefined {
  if ('work' in card) return card.work.spec.pipeline;
  return card.item.labels
    .find((label) => label.startsWith('agent:'))
    ?.slice('agent:'.length);
}

export function inboxCardKey(card: InboxCard): string {
  return 'work' in card
    ? card.work.id
    : repoItemKey(card.item.repo, card.item.number);
}

/** Any new human activity or derived CI/action classification interrupts the
 * old snooze. Native decisions also bind to the latest parked run, and
 * native reports to their report run. */
export function inboxCardSignature(card: InboxCard): string {
  if ('work' in card) {
    const report = card.kind === 'report' && nativeReportRun(card.work);
    // Bound to the report's own run: only a new report brings back a
    // dismissed one, not later bookkeeping on the item.
    if (report) return [report.runId, report.updatedAt, 'report'].join('|');
    const parked = [...card.work.runs]
      .reverse()
      .find((run) => run.result?.summary === 'park');
    return [
      card.work.updatedAt,
      parked?.runId ?? '',
      parked?.updatedAt ?? '',
      'needs-human',
    ].join('|');
  }
  return [
    card.item.updatedAt,
    [...card.item.actionTypes].sort().join('+'),
    card.item.ciRunning ? 'ci' : '',
  ].join('|');
}

/** What a native row and detail show: the report, or the parked question. */
export function nativeCardText(card: NativeDecisionCard): string {
  return (
    (card.kind === 'report' && nativeReportRun(card.work)?.result?.message) ||
    nativeDecisionQuestion(card.work)
  );
}

export function nativeDecisionQuestion(
  work: NativeDecisionCard['work'],
): string {
  return (
    [...work.runs].reverse().find((run) => run.result?.summary === 'park')
      ?.result?.message ??
    'Agent parked without a question. Open full history for context.'
  );
}

export function inboxCardMetadata(card: InboxCard) {
  if ('work' in card) {
    const [owner, name] = card.work.spec.target.repo.split('/');
    return {
      repo: { owner, name },
      updatedAt: card.work.updatedAt,
      waitingSince: card.work.updatedAt,
      actionTypes: [
        card.kind === 'report' ? 'report-ready' : 'needs-human',
      ] as const,
      rank: card.kind === 'report' ? actionTypeMeta('report-ready').rank : 0,
      search: `${card.work.id} ${card.work.spec.title} ${card.work.spec.target.repo} ${nativeCardText(card)}`,
    };
  }
  return {
    repo: card.item.repo,
    updatedAt: card.item.updatedAt,
    /** When the decision entered the queue; see ActionItem.decisionSince. */
    waitingSince: card.item.decisionSince ?? card.item.updatedAt,
    actionTypes: card.item.actionTypes,
    rank: queueReasonFor(card.item)?.rank ?? Number.MAX_SAFE_INTEGER,
    search: `${card.item.title} #${card.item.number} ${card.item.author ?? ''} ${card.item.labels.join(' ')}`,
  };
}
