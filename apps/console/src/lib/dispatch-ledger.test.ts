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

describe('parseDispatchLedger', () => {
  it('parses a well-formed pinned ledger comment', () => {
    const ledger = ledgerJson();
    const result = parseDispatchLedger(commentWithLedger(ledger), 'o/r#42');
    expect(result.warning).toBeUndefined();
    expect(result.ledger).toEqual(ledger);
  });

  it('returns nothing (no warning) for a comment with no ledger marker at all', () => {
    const result = parseDispatchLedger('just a regular comment', 'o/r#42');
    expect(result.ledger).toBeUndefined();
    expect(result.warning).toBeUndefined();
  });

  it('warns on invalid JSON after the marker', () => {
    const body = `${LEDGER_MARKER}\n\n\`\`\`json\n{ not valid json\n\`\`\`tail`;
    const result = parseDispatchLedger(body, 'o/r#42');
    expect(result.ledger).toBeUndefined();
    expect(result.warning).toMatch(/invalid JSON/);
  });

  it('warns when the marker is present but no JSON block follows', () => {
    const result = parseDispatchLedger(
      `${LEDGER_MARKER}\nno json here`,
      'o/r#42',
    );
    expect(result.ledger).toBeUndefined();
    expect(result.warning).toMatch(/one JSON block/);
  });

  it('warns on more than one JSON block (a genuinely ambiguous comment)', () => {
    const body = `${LEDGER_MARKER}\n\`\`\`json\n{"a":1}\n\`\`\`\n\`\`\`json\n{"b":2}\n\`\`\``;
    const result = parseDispatchLedger(body, 'o/r#42');
    expect(result.ledger).toBeUndefined();
    expect(result.warning).toMatch(/one JSON block/);
  });

  it('warns when the schema field is missing or wrong', () => {
    const ledger = ledgerJson({ schema: 'something-else/v9' as never });
    const result = parseDispatchLedger(commentWithLedger(ledger), 'o/r#42');
    expect(result.ledger).toBeUndefined();
    expect(result.warning).toMatch(/unexpected shape/);
  });

  it('warns when the task issue number is not a positive integer', () => {
    const ledger = ledgerJson({
      task: { repository: 'o/r', issue: -1 },
    });
    const result = parseDispatchLedger(commentWithLedger(ledger), 'o/r#42');
    expect(result.ledger).toBeUndefined();
    expect(result.warning).toMatch(/unexpected shape/);
  });

  it('warns when generations/sources are missing entirely', () => {
    const malformed = { ...ledgerJson(), generations: undefined };
    const body = `${LEDGER_MARKER}\n\`\`\`json\n${JSON.stringify(malformed)}\n\`\`\``;
    const result = parseDispatchLedger(body, 'o/r#42');
    expect(result.ledger).toBeUndefined();
    expect(result.warning).toMatch(/unexpected shape/);
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
