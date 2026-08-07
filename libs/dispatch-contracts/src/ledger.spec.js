import { describe, expect, it } from 'vitest';

import {
  extractLedgerComment,
  hasLedgerMarker,
  isWellFormedGeneration,
  isWellFormedLedger,
  isWellFormedSource,
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

  it('tolerates whitespace padding inside the fence', () => {
    // The block regex deliberately captures the fence contents verbatim
    // rather than padding the capture with `\s*` on both sides, which would
    // be a polynomial ReDoS. Parity has to hold for padded bodies, since
    // that is what the broker actually writes.
    const body = `${LEDGER_MARKER}\ns\n\n\`\`\`json   \n  {"schema":"x"}  \n \`\`\``;
    const extracted = extractLedgerComment(body);
    expect(extracted).toEqual({ ok: true, ledger: { schema: 'x' } });
  });

  it('does not backtrack on an unterminated fence full of whitespace', () => {
    // js/polynomial-redos: a comment body is attacker-controlled and the
    // console parses it server-side while rendering. The old
    // /```json\s*([\s\S]*?)\s*```/ let `\s*` and the lazy capture both match
    // the same run of spaces, giving quadratically many ways to split them.
    const evil = `${LEDGER_MARKER}\n\`\`\`json${' '.repeat(50_000)}`;
    const started = performance.now();
    expect(extractLedgerComment(evil)).toEqual({
      ok: false,
      reason: 'block-count',
      blocks: 0,
    });
    expect(performance.now() - started).toBeLessThan(500);
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

  it('rejects a task missing its repositoryId', () => {
    // The type guard promises a numeric LedgerTaskRef.repositoryId. Letting
    // one through without it hands every downstream consumer `undefined`
    // from a field the compiler said was a number -- and it is the field
    // that survives a repository rename, which the `repository` string
    // cannot do. The writer's assertTaskRef has always required it.
    expect(
      isWellFormedLedger(
        ledgerFixture({
          task: { repository: 'jlapenna/agent-lcars', issue: 645 },
        }),
      ),
    ).toBe(false);
  });

  it('rejects a non-positive repositoryId', () => {
    expect(
      isWellFormedLedger(
        ledgerFixture({
          task: {
            repositoryId: 0,
            repository: 'jlapenna/agent-lcars',
            issue: 645,
          },
        }),
      ),
    ).toBe(false);
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

  it('accepts both authorization variants a source entry can carry', () => {
    // The broker persists two genuinely different shapes: a decision
    // (`authorized`, from a label or comment) and an observation
    // (`observed`, from a completion callback, close/reopen, reconciliation,
    // or label self-heal) that carries no decision at all. Modelling only
    // the first would tell a consumer that `authorized` exists on records
    // that never had it.
    const decision = {
      sourceKind: 'labeled',
      sourceId: 's1',
      occurredAt: 'now',
      authorization: {
        authorized: true,
        actor: 'jlapenna',
        configuredMaintainer: 'jlapenna',
        rule: 'manual-maintainer',
      },
    };
    const observation = {
      sourceKind: 'completion-callback',
      sourceId: 's2',
      occurredAt: 'now',
      authorization: { observed: true, workflow: 'codex.yml' },
    };
    expect(isWellFormedSource(decision)).toBe(true);
    expect(isWellFormedSource(observation)).toBe(true);
    expect(
      isWellFormedLedger(ledgerFixture({ sources: [decision, observation] })),
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
