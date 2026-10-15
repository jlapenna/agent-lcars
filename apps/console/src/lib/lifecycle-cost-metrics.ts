import 'server-only';

import {
  getSessionArchive,
  ONE_HOUR_DAYS,
  type SessionArchiveResult,
} from './session-archive';

const PIPELINES = ['claude', 'codex', 'opencode', 'unknown'] as const;

/** The existing SessionSpend owner supplies all arithmetic and PR qualification.
 * These gauges describe cumulative selected-session spend, not hourly charges,
 * task invoices or independent verified Work outcomes. */
export function lifecycleCostMetrics(archive?: SessionArchiveResult): string {
  const spend = archive?.spend;
  const available = archive?.available !== false && spend !== undefined;
  const rows = spend?.byPipeline ?? [];
  const valid =
    available &&
    rows.every(
      (row) =>
        PIPELINES.some((pipeline) => pipeline === row.key) &&
        [
          row.sessions,
          row.reportedCostUsd,
          row.estimatedCostUsd,
          row.unpricedSessions,
          row.mergedPRs,
          row.unknownPRs,
          row.unqualifiedPRReferences,
          ...(row.costPerMergedDeliverableUsd === undefined
            ? []
            : [row.costPerMergedDeliverableUsd]),
        ].every((value) => Number.isFinite(value) && value >= 0),
    );
  const complete =
    valid && !spend?.coverageLimited && archive?.warnings.length === 0;
  const lines: string[] = [];
  function gauge(name: string, help: string, samples: string[]) {
    const metric = `lcars_product_${name}`;
    lines.push(
      `# HELP ${metric} ${help}`,
      `# TYPE ${metric} gauge`,
      ...samples.map((sample) => `${metric}${sample}`),
    );
  }
  gauge(
    'session_cost_read_available',
    'One when the selected session spend is readable and finite.',
    [` ${Number(valid)}`],
  );
  gauge(
    'session_cost_read_complete',
    'One when archive and stored merge evidence reads are complete; prices may remain unknown.',
    [` ${Number(complete)}`],
  );
  if (!valid) return lines.join('\n') + '\n';
  const values = PIPELINES.map((pipeline) => ({
    pipeline,
    row: rows.find((row) => row.key === pipeline),
  }));
  for (const [name, help, field] of [
    [
      'sessions',
      'Selected sessions active during the rolling hour, including retry and failed sessions.',
      'sessions',
    ],
    [
      'reported_usd',
      'Cumulative selected-session provider-reported USD; not hourly charges or invoices.',
      'reportedCostUsd',
    ],
    [
      'estimated_usd',
      'Cumulative selected-session estimated USD using the canonical published model rates.',
      'estimatedCostUsd',
    ],
    [
      'unpriced_sessions',
      'Selected sessions without a known reported or estimated price.',
      'unpricedSessions',
    ],
    [
      'merged_prs',
      'Unique qualified known-merged PRs referenced by the same selected-session cohort, regardless of merge date.',
      'mergedPRs',
    ],
    [
      'unknown_prs',
      'Unique qualified cohort PRs without known stored merge status.',
      'unknownPRs',
    ],
    [
      'unqualified_pr_references',
      'Session PR-number references without qualified repository attribution.',
      'unqualifiedPRReferences',
    ],
  ] as const) {
    gauge(
      `session_cost_${name}`,
      help,
      values.map(
        ({ pipeline, row }) => `{pipeline="${pipeline}"} ${row?.[field] ?? 0}`,
      ),
    );
  }
  gauge(
    'session_cost_per_merged_pr_proxy_usd',
    'All priced cumulative cohort spend divided by unique known-merged cohort PRs; partial coverage is labelled, and unknown-price-only ratios are omitted.',
    values.flatMap(({ pipeline, row }) =>
      row?.costPerMergedDeliverableUsd === undefined
        ? []
        : [
            `{pipeline="${pipeline}",coverage="${complete && row.unpricedSessions === 0 && row.unknownPRs === 0 && row.unqualifiedPRReferences === 0 ? 'complete' : 'partial'}"} ${row.costPerMergedDeliverableUsd}`,
          ],
    ),
  );
  return lines.join('\n') + '\n';
}

export async function readLifecycleCostMetrics(
  observedAt: string,
): Promise<string> {
  try {
    return lifecycleCostMetrics(
      await getSessionArchive(
        { days: ONE_HOUR_DAYS },
        {
          includeSpend: true,
          observedAt,
          spendPipelineGrouping: 'lifecycle',
        },
      ),
    );
  } catch {
    // Read failures expose fixed health gauges, never credential-bearing SDK errors.
    return lifecycleCostMetrics();
  }
}
