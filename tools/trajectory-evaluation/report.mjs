import { validateCorpus, validateVariant } from './schema.mjs';

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function round(value, digits = 3) {
  if (value === null) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

function grouped(entries, field) {
  const groups = new Map();
  for (const entry of entries) {
    const key = field(entry);
    const values = groups.get(key) ?? [];
    values.push(entry);
    groups.set(key, values);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, summarizeEntries(values)]),
  );
}

function timing(entries, field) {
  const values = entries
    .map((entry) => entry.efficiency[field])
    .filter((value) => value !== null);
  return {
    samples: values.length,
    medianSeconds: percentile(values, 0.5),
    p95Seconds: percentile(values, 0.95),
  };
}

function milestoneTiming(entries, field) {
  const values = entries
    .map((entry) => {
      const milestone = entry.milestones[field];
      return milestone === null
        ? null
        : (Date.parse(milestone) - Date.parse(entry.milestones.queuedAt)) /
            1000;
    })
    .filter((value) => value !== null);
  return {
    samples: values.length,
    medianSeconds: percentile(values, 0.5),
    p95Seconds: percentile(values, 0.95),
  };
}

export function summarizeEntries(entries) {
  const total = entries.length;
  const workflowSuccesses = entries.filter(
    (entry) => entry.dispatch.workflowConclusion === 'success',
  ).length;
  const preModelFailures = entries.filter(
    (entry) => entry.setup.modelTurnObserved === false,
  ).length;
  const runnable = entries.filter(
    (entry) => entry.setup.modelTurnObserved === true,
  );
  const usefulRunnable = runnable.filter(
    (entry) => entry.annotations.human?.useful === true,
  ).length;
  const accepted = entries.filter(
    (entry) => entry.quality.accepted === true,
  ).length;
  const reviewedProtocol = entries.filter(
    (entry) => entry.protocol.adherent !== null,
  );
  const protocolAdherent = reviewedProtocol.filter(
    (entry) => entry.protocol.adherent === true,
  ).length;
  const mergedGreen = entries.filter(
    (entry) =>
      entry.terminal.kind === 'merged-deliverable' &&
      entry.quality.merged === true &&
      entry.quality.ci === 'green',
  ).length;
  const falseNegatives = entries.filter(
    (entry) =>
      entry.terminal.kind === 'outcome-gate-failure' &&
      entry.annotations.human?.useful === true,
  ).length;
  const repeatedOrTimedOut = entries.filter(
    (entry) =>
      entry.terminal.kind === 'superseded-duplicate' ||
      entry.trajectory.outcome === 'loop',
  ).length;
  const parkOrNoOp = entries.filter((entry) =>
    ['correct-park', 'correct-no-op', 'outcome-gate-failure'].includes(
      entry.terminal.kind,
    ),
  );
  const correctParkOrNoOp = parkOrNoOp.filter(
    (entry) => entry.annotations.human?.correctness === 'correct',
  ).length;
  const reviewDefects = entries.filter(
    (entry) => entry.quality.review === 'defect-found',
  ).length;
  const reviewedDeliverables = entries.filter((entry) =>
    ['no-objection', 'defect-found'].includes(entry.quality.review),
  ).length;
  const runnerMinutesLostToSetup = entries
    .filter((entry) => entry.setup.modelTurnObserved === false)
    .reduce(
      (totalMinutes, entry) =>
        totalMinutes + (entry.efficiency.runnerMinutes ?? 0),
      0,
    );

  const outcomeCounts = {};
  for (const entry of entries)
    outcomeCounts[entry.terminal.kind] =
      (outcomeCounts[entry.terminal.kind] ?? 0) + 1;

  return {
    total,
    workflowSuccesses,
    workflowFailures: total - workflowSuccesses,
    rawWorkflowSuccessRate: round(rate(workflowSuccesses, total)),
    preModelFailures,
    startupAvailabilityRate: round(rate(total - preModelFailures, total)),
    runnable: runnable.length,
    usefulRunnable,
    usefulOutcomeRateConditionalOnModelStart: round(
      rate(usefulRunnable, runnable.length),
    ),
    accepted,
    acceptedOutcomeRate: round(rate(accepted, total)),
    reviewedProtocol: reviewedProtocol.length,
    protocolAdherent,
    protocolAdherenceRate: round(
      rate(protocolAdherent, reviewedProtocol.length),
    ),
    mergedGreen,
    mergedGreenRate: round(rate(mergedGreen, total)),
    reviewDefects,
    reviewDefectRate: round(rate(reviewDefects, reviewedDeliverables)),
    falseNegatives,
    reviewedParkOrNoOp: parkOrNoOp.length,
    correctParkOrNoOp,
    parkOrNoOpCorrectnessRate: round(
      rate(correctParkOrNoOp, parkOrNoOp.length),
    ),
    repeatedOrTimedOut,
    runnerMinutesLostToSetup: round(runnerMinutesLostToSetup, 1),
    outcomeCounts,
    timing: {
      queue: timing(entries, 'queueSeconds'),
      takeover: milestoneTiming(entries, 'takeoverAt'),
      model: timing(entries, 'modelSeconds'),
      firstArtifact: timing(entries, 'firstArtifactSeconds'),
    },
  };
}

export function buildReport(corpusValue) {
  const corpus = validateCorpus(corpusValue);
  return {
    schemaVersion: 'agent-lcars.trajectory-report/v1',
    corpusId: corpus.corpusId,
    generatedFromFrozenAt: corpus.frozenAt,
    overall: summarizeEntries(corpus.entries),
    byAgent: grouped(corpus.entries, (entry) => entry.dispatch.agent),
    byTaskClass: grouped(corpus.entries, (entry) => entry.taskClass),
    provenance: {
      automaticFields:
        'workflow metadata, job steps, timestamps, and exact artifact references',
      humanFields:
        'usefulness, semantic correctness, and counterfactual expectations',
      warning:
        'A PR reference or green workflow is not semantic correctness. Human judgments remain separate and are never inferred from artifact existence.',
    },
  };
}

function percent(value) {
  return value === null ? 'n/a' : `${Math.round(value * 1000) / 10}%`;
}

function timingText(value) {
  if (value.samples === 0) return 'n/a (0 samples)';
  return `${value.medianSeconds}s / ${value.p95Seconds}s (${value.samples} samples)`;
}

function groupTable(groups) {
  const lines = [
    '| Group | Runs | Raw success | Runnable useful | Accepted |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const [name, summary] of Object.entries(groups)) {
    lines.push(
      `| ${name} | ${summary.total} | ${percent(summary.rawWorkflowSuccessRate)} | ${percent(
        summary.usefulOutcomeRateConditionalOnModelStart,
      )} | ${summary.accepted} |`,
    );
  }
  return lines.join('\n');
}

export function renderMarkdown(report) {
  const summary = report.overall;
  return `# Trajectory evaluation: ${report.corpusId}

- Raw workflow success: ${summary.workflowSuccesses}/${summary.total} (${percent(summary.rawWorkflowSuccessRate)})
- Pre-model failures: ${summary.preModelFailures}/${summary.total}
- Useful runnable outcomes: ${summary.usefulRunnable}/${summary.runnable} (${percent(
    summary.usefulOutcomeRateConditionalOnModelStart,
  )})
- Reviewed protocol adherence: ${summary.protocolAdherent}/${summary.reviewedProtocol} (${percent(
    summary.protocolAdherenceRate,
  )})
- Accepted outcomes: ${summary.accepted}/${summary.total}
- Merged green deliverables: ${summary.mergedGreen}
- Review defects: ${summary.reviewDefects}
- Correct reviewed park/no-op outcomes: ${summary.correctParkOrNoOp}/${summary.reviewedParkOrNoOp} (${percent(
    summary.parkOrNoOpCorrectnessRate,
  )})
- Outcome-gate false negatives: ${summary.falseNegatives}
- Repeated-state/timeout outcomes: ${summary.repeatedOrTimedOut}
- Runner minutes lost before model work: ${summary.runnerMinutesLostToSetup}
- Median/p95 queue time: ${timingText(summary.timing.queue)}
- Median/p95 time to takeover: ${timingText(summary.timing.takeover)}
- Median/p95 model time: ${timingText(summary.timing.model)}
- Median/p95 time to first durable artifact: ${timingText(summary.timing.firstArtifact)}

## By agent

${groupTable(report.byAgent)}

## By task class

${groupTable(report.byTaskClass)}

## Interpretation boundary

${report.provenance.warning}
`;
}

export function compareVariant(corpusValue, variantValue) {
  const corpus = validateCorpus(corpusValue);
  const variant = validateVariant(variantValue);
  const entries = structuredClone(corpus.entries);
  const applied = [];
  const corpusIds = new Set(entries.map((entry) => entry.id));

  for (const entryId of Object.keys(variant.reviewedExpectations)) {
    if (!corpusIds.has(entryId))
      throw new Error(
        `variant expectation ${entryId} is not present in the corpus`,
      );
  }

  for (const entry of entries) {
    const expectation = variant.reviewedExpectations[entry.id];
    if (!expectation) continue;
    if (entry.annotations.human === null) {
      throw new Error(
        `variant expectation ${entry.id} requires a reviewed corpus entry`,
      );
    }
    entry.terminal.kind = expectation.kind;
    entry.annotations.human.useful = expectation.useful;
    entry.quality.accepted = expectation.accepted;
    entry.annotations.human.confidence = expectation.confidence;
    entry.annotations.human.reviewer = expectation.reviewer;
    entry.annotations.human.reviewedAt = expectation.reviewedAt;
    entry.annotations.human.notes = expectation.rationale;
    if (expectation.protocolAdherent !== undefined) {
      entry.protocol.adherent = expectation.protocolAdherent;
    }
    if (expectation.trajectoryOutcome !== undefined) {
      entry.trajectory.outcome = expectation.trajectoryOutcome;
    }
    if (expectation.firstArtifactSeconds !== undefined) {
      entry.efficiency.firstArtifactSeconds = expectation.firstArtifactSeconds;
    }
    applied.push({
      entryId: entry.id,
      confidence: expectation.confidence,
      reviewer: expectation.reviewer,
      rationale: expectation.rationale,
      provenance: 'human-reviewed-counterfactual',
    });
  }

  const candidateCorpus = {
    ...corpus,
    corpusId: `${corpus.corpusId}@${variant.variantId}`,
    entries,
  };
  return {
    schemaVersion: 'agent-lcars.trajectory-comparison/v1',
    variant: {
      id: variant.variantId,
      kind: variant.kind,
      description: variant.description,
    },
    baseline: buildReport(corpus),
    candidate: buildReport(candidateCorpus),
    applied,
    boundary:
      'Candidate deltas are offline, human-reviewed counterfactuals. They are not production measurements and cannot replace isolated execution plus semantic review.',
  };
}

function comparisonGroupTable(baselineGroups, candidateGroups) {
  const lines = [
    '| Group | Accepted baseline | Accepted candidate | Protocol baseline | Protocol candidate |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const name of Object.keys(baselineGroups)) {
    const baseline = baselineGroups[name];
    const candidate = candidateGroups[name];
    lines.push(
      `| ${name} | ${baseline.accepted}/${baseline.total} | ${candidate.accepted}/${candidate.total} | ${percent(
        baseline.protocolAdherenceRate,
      )} | ${percent(candidate.protocolAdherenceRate)} |`,
    );
  }
  return lines.join('\n');
}

function regressionStatus(baseline, candidate, direction = 'higher') {
  if (baseline === null || candidate === null || baseline === candidate)
    return 'unchanged';
  const regressed =
    direction === 'higher' ? candidate < baseline : candidate > baseline;
  return regressed ? 'regressed' : 'improved';
}

export function renderComparisonMarkdown(comparison) {
  const baseline = comparison.baseline.overall;
  const candidate = comparison.candidate.overall;
  return `# Variant comparison: ${comparison.variant.id}

${comparison.variant.description}

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Accepted outcomes | ${baseline.accepted}/${baseline.total} | ${candidate.accepted}/${candidate.total} |
| Useful runnable outcomes | ${baseline.usefulRunnable}/${baseline.runnable} | ${candidate.usefulRunnable}/${candidate.runnable} |
| Startup availability (observed) | ${percent(baseline.startupAvailabilityRate)} | ${percent(candidate.startupAvailabilityRate)} |
| Reviewed protocol adherence | ${percent(baseline.protocolAdherenceRate)} | ${percent(candidate.protocolAdherenceRate)} |
| Repeated-state/timeout outcomes | ${baseline.repeatedOrTimedOut} | ${candidate.repeatedOrTimedOut} |
| Median time to first artifact | ${baseline.timing.firstArtifact.medianSeconds ?? 'n/a'}s | ${candidate.timing.firstArtifact.medianSeconds ?? 'n/a'}s |
| Outcome-gate false negatives | ${baseline.falseNegatives} | ${candidate.falseNegatives} |

Applied reviewed expectations: ${comparison.applied.length}.

## Regression checks

| Dimension | Status |
| --- | --- |
| Startup availability | ${regressionStatus(baseline.startupAvailabilityRate, candidate.startupAvailabilityRate)} |
| Protocol adherence | ${regressionStatus(baseline.protocolAdherenceRate, candidate.protocolAdherenceRate)} |
| Looping/timeouts | ${regressionStatus(baseline.repeatedOrTimedOut, candidate.repeatedOrTimedOut, 'lower')} |
| Time to first durable artifact | ${regressionStatus(
    baseline.timing.firstArtifact.medianSeconds,
    candidate.timing.firstArtifact.medianSeconds,
    'lower',
  )} |
| Accepted outcomes | ${regressionStatus(baseline.acceptedOutcomeRate, candidate.acceptedOutcomeRate)} |

## By agent

${comparisonGroupTable(comparison.baseline.byAgent, comparison.candidate.byAgent)}

## By task class

${comparisonGroupTable(comparison.baseline.byTaskClass, comparison.candidate.byTaskClass)}

> ${comparison.boundary}
`;
}
