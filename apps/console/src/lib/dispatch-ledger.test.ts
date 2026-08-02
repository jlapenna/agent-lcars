import { describe, expect, it } from 'vitest';

import {
  type DispatchLedger,
  findLedgerCommentBody,
  LEDGER_MARKER,
  parseDispatchLedger,
  sourceKindForGeneration,
} from './dispatch-ledger';

function ledgerJson(overrides: Partial<DispatchLedger> = {}): DispatchLedger {
  return {
    schema: 'agent-lcars.dispatch-ledger/v1',
    revision: 3,
    task: { repository: 'supersprinklesracing/sprinkles', issue: 42 },
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:10:00Z',
    control: { closed: false },
    sources: [
      {
        sourceKind: 'labeled',
        sourceId: 'label-1',
        transportRunId: 1,
        occurredAt: '2026-07-01T00:00:00Z',
      },
    ],
    generations: [
      {
        generation: 1,
        intentId: 'intent-abc123',
        sourceId: 'label-1',
        occurredAt: '2026-07-01T00:00:00Z',
        pipeline: 'claude',
        mode: 'implement',
        state: 'active',
        attempt: { runId: 555, status: 'in_progress' },
      },
    ],
    anomalies: [],
    ...overrides,
  };
}

function commentWithLedger(ledger: DispatchLedger): string {
  return `${LEDGER_MARKER}\nDispatch broker: g1 claude is active.\n\n<details><summary>Machine state</summary>\n\n\`\`\`json\n${JSON.stringify(ledger)}\n\`\`\`\n\n</details>`;
}

/** Matches `ledgerJson()`'s default `task` field - the task
 * `parseDispatchLedger`'s caller expects the comment it scanned to belong
 * to. */
const EXPECTED_TASK = {
  repository: 'supersprinklesracing/sprinkles',
  issue: 42,
};

describe('parseDispatchLedger', () => {
  it('parses a well-formed pinned ledger comment', () => {
    const ledger = ledgerJson();
    const result = parseDispatchLedger(
      commentWithLedger(ledger),
      EXPECTED_TASK,
    );
    expect(result.warning).toBeUndefined();
    expect(result.ledger).toEqual(ledger);
  });

  it('returns nothing (no warning) for a comment with no ledger marker at all', () => {
    const result = parseDispatchLedger('just a regular comment', EXPECTED_TASK);
    expect(result.ledger).toBeUndefined();
    expect(result.warning).toBeUndefined();
  });

  it('warns on invalid JSON after the marker', () => {
    const body = `${LEDGER_MARKER}\n\n\`\`\`json\n{ not valid json\n\`\`\`tail`;
    const result = parseDispatchLedger(body, EXPECTED_TASK);
    expect(result.ledger).toBeUndefined();
    expect(result.warning).toMatch(/invalid JSON/);
  });

  it('warns when the marker is present but no JSON block follows', () => {
    const result = parseDispatchLedger(
      `${LEDGER_MARKER}\nno json here`,
      EXPECTED_TASK,
    );
    expect(result.ledger).toBeUndefined();
    expect(result.warning).toMatch(/one JSON block/);
  });

  it('warns on more than one JSON block (a genuinely ambiguous comment)', () => {
    const body = `${LEDGER_MARKER}\n\`\`\`json\n{"a":1}\n\`\`\`\n\`\`\`json\n{"b":2}\n\`\`\``;
    const result = parseDispatchLedger(body, EXPECTED_TASK);
    expect(result.ledger).toBeUndefined();
    expect(result.warning).toMatch(/one JSON block/);
  });

  it('warns when the schema field is missing or wrong', () => {
    const ledger = ledgerJson({ schema: 'something-else/v9' as never });
    const result = parseDispatchLedger(
      commentWithLedger(ledger),
      EXPECTED_TASK,
    );
    expect(result.ledger).toBeUndefined();
    expect(result.warning).toMatch(/unexpected shape/);
  });

  it('warns when the task issue number is not a positive integer', () => {
    const ledger = ledgerJson({
      task: { repository: 'o/r', issue: -1 },
    });
    const result = parseDispatchLedger(
      commentWithLedger(ledger),
      EXPECTED_TASK,
    );
    expect(result.ledger).toBeUndefined();
    expect(result.warning).toMatch(/unexpected shape/);
  });

  it('warns when generations/sources are missing entirely', () => {
    const malformed = { ...ledgerJson(), generations: undefined };
    const body = `${LEDGER_MARKER}\n\`\`\`json\n${JSON.stringify(malformed)}\n\`\`\``;
    const result = parseDispatchLedger(body, EXPECTED_TASK);
    expect(result.ledger).toBeUndefined();
    expect(result.warning).toMatch(/unexpected shape/);
  });

  // Codex review (#364): a structurally valid ledger could previously be
  // accepted and displayed even when it actually named a different
  // issue/repo - e.g. a comment copy-pasted from elsewhere, or a stray
  // marker in an unrelated thread. `expectedTask` must now match the
  // parsed ledger's own `task` field.
  it('rejects a structurally valid ledger whose task field points at a different issue', () => {
    const ledger = ledgerJson({
      task: { repository: 'supersprinklesracing/sprinkles', issue: 999 },
    });
    const result = parseDispatchLedger(
      commentWithLedger(ledger),
      EXPECTED_TASK,
    );
    expect(result.ledger).toBeUndefined();
    expect(result.warning).toMatch(/actually references/);
    expect(result.warning).toContain('999');
  });

  it('rejects a structurally valid ledger whose task field points at a different repository', () => {
    const ledger = ledgerJson({
      task: { repository: 'someone-else/other-repo', issue: 42 },
    });
    const result = parseDispatchLedger(
      commentWithLedger(ledger),
      EXPECTED_TASK,
    );
    expect(result.ledger).toBeUndefined();
    expect(result.warning).toMatch(/actually references/);
    expect(result.warning).toContain('someone-else/other-repo');
  });

  it('matches the task repository case-insensitively (mirrors broker.mjs)', () => {
    const ledger = ledgerJson({
      task: { repository: 'SuperSprinklesRacing/Sprinkles', issue: 42 },
    });
    const result = parseDispatchLedger(
      commentWithLedger(ledger),
      EXPECTED_TASK,
    );
    expect(result.warning).toBeUndefined();
    expect(result.ledger).toBeDefined();
  });

  // Codex review (#364, P1): isWellFormedLedger used to only check that
  // `generations` was an array, not that each element had the required
  // fields - a real (not just crafted) malformed ledger with e.g. a null
  // generation, or one missing `state`, passed validation and then crashed
  // logical-work.ts's consumers downstream instead of degrading like any
  // other malformed ledger.
  it('degrades (does not throw) when a generation element is null', () => {
    const malformed = { ...ledgerJson(), generations: [null] };
    const body = `${LEDGER_MARKER}\n\`\`\`json\n${JSON.stringify(malformed)}\n\`\`\``;
    const result = parseDispatchLedger(body, EXPECTED_TASK);
    expect(result.ledger).toBeUndefined();
    expect(result.warning).toMatch(/unexpected shape/);
  });

  it('degrades (does not throw) when a generation is missing state', () => {
    const badGeneration = { ...ledgerJson().generations[0] };
    delete (badGeneration as { state?: unknown }).state;
    const malformed = { ...ledgerJson(), generations: [badGeneration] };
    const body = `${LEDGER_MARKER}\n\`\`\`json\n${JSON.stringify(malformed)}\n\`\`\``;
    const result = parseDispatchLedger(body, EXPECTED_TASK);
    expect(result.ledger).toBeUndefined();
    expect(result.warning).toMatch(/unexpected shape/);
  });

  it('degrades (does not throw) when a generation has an unrecognized pipeline or state value', () => {
    const badPipeline = {
      ...ledgerJson().generations[0],
      pipeline: 'not-a-real-pipeline',
    };
    const malformedPipeline = { ...ledgerJson(), generations: [badPipeline] };
    const pipelineResult = parseDispatchLedger(
      `${LEDGER_MARKER}\n\`\`\`json\n${JSON.stringify(malformedPipeline)}\n\`\`\``,
      EXPECTED_TASK,
    );
    expect(pipelineResult.ledger).toBeUndefined();

    const badState = { ...ledgerJson().generations[0], state: 'not-a-state' };
    const malformedState = { ...ledgerJson(), generations: [badState] };
    const stateResult = parseDispatchLedger(
      `${LEDGER_MARKER}\n\`\`\`json\n${JSON.stringify(malformedState)}\n\`\`\``,
      EXPECTED_TASK,
    );
    expect(stateResult.ledger).toBeUndefined();
  });

  it('degrades (does not throw) when a source or anomaly element is malformed', () => {
    const malformedSource = {
      ...ledgerJson(),
      sources: [{ sourceKind: 'labeled' /* missing sourceId */ }],
    };
    const sourceResult = parseDispatchLedger(
      `${LEDGER_MARKER}\n\`\`\`json\n${JSON.stringify(malformedSource)}\n\`\`\``,
      EXPECTED_TASK,
    );
    expect(sourceResult.ledger).toBeUndefined();

    const malformedAnomaly = {
      ...ledgerJson(),
      anomalies: [
        { detail: { generation: 1, runIds: [1, 2] } /* no kind/occurredAt */ },
      ],
    };
    const anomalyResult = parseDispatchLedger(
      `${LEDGER_MARKER}\n\`\`\`json\n${JSON.stringify(malformedAnomaly)}\n\`\`\``,
      EXPECTED_TASK,
    );
    expect(anomalyResult.ledger).toBeUndefined();
  });

  it('still parses a ledger whose generations/sources/anomalies are all well-formed, including a real anomaly', () => {
    const ledger = ledgerJson({
      anomalies: [
        {
          kind: 'duplicate-attempt',
          detail: { generation: 1, runIds: [111, 222] },
          occurredAt: '2026-07-01T00:05:00Z',
        },
      ],
    });
    const result = parseDispatchLedger(
      commentWithLedger(ledger),
      EXPECTED_TASK,
    );
    expect(result.warning).toBeUndefined();
    expect(result.ledger?.anomalies).toHaveLength(1);
  });
});

describe('findLedgerCommentBody', () => {
  it('finds the marker among unrelated comments', () => {
    const ledger = ledgerJson();
    const body = findLedgerCommentBody([
      { body: 'hello' },
      { body: commentWithLedger(ledger) },
      { body: 'thanks!' },
    ]);
    expect(body).toContain(LEDGER_MARKER);
  });

  it('returns undefined when no comment carries the marker', () => {
    expect(
      findLedgerCommentBody([{ body: 'a' }, { body: 'b' }]),
    ).toBeUndefined();
  });

  it('returns the newest match when more than one comment carries the marker (anomalous)', () => {
    const older = commentWithLedger(ledgerJson({ revision: 1 }));
    const newer = commentWithLedger(ledgerJson({ revision: 2 }));
    const body = findLedgerCommentBody([{ body: older }, { body: newer }]);
    expect(body).toBe(newer);
  });
});

describe('sourceKindForGeneration', () => {
  it('finds the source evidence backing a generation', () => {
    const ledger = ledgerJson();
    expect(sourceKindForGeneration(ledger, ledger.generations[0])).toBe(
      'labeled',
    );
  });

  it('returns undefined when no source matches the generation sourceId', () => {
    const ledger = ledgerJson({
      generations: [
        { ...ledgerJson().generations[0], sourceId: 'missing-source' },
      ],
    });
    expect(
      sourceKindForGeneration(ledger, ledger.generations[0]),
    ).toBeUndefined();
  });
});
