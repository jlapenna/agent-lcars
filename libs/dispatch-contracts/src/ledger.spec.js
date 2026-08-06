import { describe, expect, it } from 'vitest';

import {
  extractLedgerComment,
  hasLedgerMarker,
  isWellFormedGeneration,
  isWellFormedLedger,
  LEDGER_ACTIVE_GENERATION_STATES,
  LEDGER_GENERATION_STATES,
  LEDGER_MARKER,
  LEDGER_SCHEMA,
  renderLedgerComment,
} from './ledger.js';

/** @returns {import('./ledger.js').DispatchLedger} */
function ledgerFixture(overrides = {}) {
  return {
    schema: LEDGER_SCHEMA,
    revision: 3,
    task: {
      repositoryId: 1307149765,
      repository: 'jlapenna/agent-lcars',
      issue: 645,
    },
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:05:00.000Z',
    control: { closed: false },
    sources: [
      {
        sourceKind: 'labeled',
        sourceId: 'label-1',
        occurredAt: '2026-08-06T00:00:00.000Z',
      },
    ],
    generations: [
      {
        generation: 1,
        intentId: 'intent-1',
        sourceId: 'label-1',
        occurredAt: '2026-08-06T00:00:00.000Z',
        pipeline: 'codex',
        state: 'active',
        attempt: { token: 'tok', runId: 42 },
      },
    ],
    anomalies: [],
    ...overrides,
  };
}

describe('the comment envelope', () => {
  it('round-trips a ledger through render and extract', () => {
    const ledger = ledgerFixture();
    const extracted = extractLedgerComment(
      renderLedgerComment(ledger, 'Dispatch broker: g1 codex is active.'),
    );
    expect(extracted).toEqual({ ok: true, ledger });
  });

  it('keeps the summary visible and the machine state collapsed', () => {
    const comment = renderLedgerComment(ledgerFixture(), 'A summary line.');
    expect(comment.startsWith(LEDGER_MARKER)).toBe(true);
    expect(comment).toContain('A summary line.');
    expect(comment).toContain('<details><summary>Machine state</summary>');
  });

  it('reports a comment with no marker as no-marker, not as malformed', () => {
    // An issue predating the broker rollout has no ledger comment at all.
    // Conflating that with corruption would turn every old issue into a
    // warning on the dashboard.
    expect(extractLedgerComment('just a normal comment')).toEqual({
      ok: false,
      reason: 'no-marker',
    });
    expect(extractLedgerComment(undefined)).toEqual({
      ok: false,
      reason: 'no-marker',
    });
  });

  it('refuses to guess when a second JSON block appears', () => {
    const body = `${LEDGER_MARKER}\nsummary\n\n\`\`\`json\n{"a":1}\n\`\`\`\n\`\`\`json\n{"b":2}\n\`\`\``;
    expect(extractLedgerComment(body)).toEqual({
      ok: false,
      reason: 'block-count',
      blocks: 2,
    });
  });

  it('reports a marker with no block at all', () => {
    expect(extractLedgerComment(`${LEDGER_MARKER}\nsummary only`)).toEqual({
      ok: false,
      reason: 'block-count',
      blocks: 0,
    });
  });

  it('separates invalid JSON from a missing block', () => {
    const body = `${LEDGER_MARKER}\ns\n\n\`\`\`json\n{not json\n\`\`\``;
    expect(extractLedgerComment(body)).toEqual({
      ok: false,
      reason: 'invalid-json',
    });
  });

  it('detects the marker independently of the payload', () => {
    expect(hasLedgerMarker(`prefix ${LEDGER_MARKER} suffix`)).toBe(true);
    expect(hasLedgerMarker('no marker here')).toBe(false);
  });
});

describe('the state vocabulary', () => {
  it('treats every active state as a known state', () => {
    for (const state of LEDGER_ACTIVE_GENERATION_STATES) {
      expect(LEDGER_GENERATION_STATES).toContain(state);
    }
  });

  it('excludes terminal states from the active set', () => {
    for (const state of ['completed', 'superseded', 'superseded-by-close']) {
      expect(LEDGER_ACTIVE_GENERATION_STATES.has(state)).toBe(false);
    }
  });
});

describe('isWellFormedLedger', () => {
  it('accepts a ledger the broker would write', () => {
    expect(isWellFormedLedger(ledgerFixture())).toBe(true);
  });

  it('rejects a foreign schema', () => {
    expect(isWellFormedLedger(ledgerFixture({ schema: 'something/v2' }))).toBe(
      false,
    );
  });

  it.each([
    ['a null generation', { generations: [null] }],
    ['a generation missing state', { generations: [{ generation: 1 }] }],
    ['a non-array generations', { generations: {} }],
    ['a missing control block', { control: undefined }],
    ['a negative revision', { revision: -1 }],
  ])('rejects %s', (_label, overrides) => {
    // Each of these used to pass a check that only verified `generations`
    // was an array, then crash rendering downstream.
    expect(isWellFormedLedger(ledgerFixture(overrides))).toBe(false);
  });

  it('rejects a generation naming an unknown pipeline', () => {
    expect(
      isWellFormedGeneration({
        generation: 1,
        intentId: 'i',
        sourceId: 's',
        occurredAt: 'now',
        pipeline: 'gemini',
        state: 'active',
      }),
    ).toBe(false);
  });

  it('accepts the canary pipeline, which the broker does persist', () => {
    expect(
      isWellFormedGeneration({
        generation: 1,
        intentId: 'i',
        sourceId: 's',
        occurredAt: 'now',
        pipeline: 'canary',
        state: 'active',
      }),
    ).toBe(true);
  });

  it('rejects an attempt that is not an object', () => {
    expect(
      isWellFormedGeneration({
        generation: 1,
        intentId: 'i',
        sourceId: 's',
        occurredAt: 'now',
        pipeline: 'codex',
        state: 'active',
        attempt: 'nope',
      }),
    ).toBe(false);
  });
});
