import { describe, expect, it } from 'vitest';

import {
  CURRENCIES,
  STOP_REASONS,
  TOOL_KINDS,
  TOOL_STATUSES,
  turnEvidence,
} from '../../apps/runner-autoscaler/claw-image/claw-job.mjs';
import {
  recordRunEvidence,
  RUN_EVIDENCE_CURRENCIES,
  RUN_EVIDENCE_STOP_REASONS,
  RUN_EVIDENCE_TOOL_CALLS_MAX,
  RUN_EVIDENCE_TOOL_KINDS,
  RUN_EVIDENCE_TOOL_STATUSES,
  runEvidenceReportSchema,
} from '../../libs/dispatch-contracts/src/run-evidence';

const recordedAt = '2026-11-20T00:00:00.000Z';

function record(input: Parameters<typeof turnEvidence>[0]) {
  const report = { source: 'acp', harness: 'openclaw', ...turnEvidence(input) };
  return recordRunEvidence(runEvidenceReportSchema.parse(report), recordedAt);
}

describe('Claw evidence received by the Work API', () => {
  it('uses the same vocabulary on both sides of the wire', () => {
    expect(new Set(TOOL_KINDS)).toEqual(new Set(RUN_EVIDENCE_TOOL_KINDS));
    expect(new Set(TOOL_STATUSES)).toEqual(new Set(RUN_EVIDENCE_TOOL_STATUSES));
    expect(new Set(STOP_REASONS)).toEqual(new Set(RUN_EVIDENCE_STOP_REASONS));
    expect(new Set(CURRENCIES)).toEqual(new Set(RUN_EVIDENCE_CURRENCIES));
  });

  const tools = RUN_EVIDENCE_TOOL_KINDS.flatMap((kind) =>
    RUN_EVIDENCE_TOOL_STATUSES.map((status) => ({ kind, status })),
  );

  it('preserves every supported tool kind and status', () => {
    expect(record({ tools }).toolCalls).toEqual(tools);
  });

  it.each(RUN_EVIDENCE_STOP_REASONS)(
    'preserves stop reason %s',
    (stopReason) => {
      expect(record({ tools: [], stopReason }).stopReason).toBe(stopReason);
    },
  );

  it.each(RUN_EVIDENCE_CURRENCIES)('preserves cost in %s', (currency) => {
    const cost = { amount: 1, currency };
    expect(record({ tools: [], context: { cost } }).usage?.cost).toEqual(cost);
  });

  it('records the first calls up to the API limit and counts every call', () => {
    const calls = Array.from(
      { length: RUN_EVIDENCE_TOOL_CALLS_MAX + 1 },
      (_, index) => tools[index % tools.length],
    );
    const evidence = record({ tools: calls });
    expect(evidence.toolCallCount).toBe(calls.length);
    expect(evidence.toolCalls).toEqual(
      calls.slice(0, RUN_EVIDENCE_TOOL_CALLS_MAX),
    );
  });
});
