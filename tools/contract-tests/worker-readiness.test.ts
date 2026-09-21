import { describe, expect, it } from 'vitest';

import readiness from '../../packages/fleet-tools/bin/worker-readiness.cjs';

const { evaluate, scenarios } = readiness;
const now = Date.parse('2026-09-20T12:00:00Z');
const expected = {
  provider: 'codex',
  providerVersion: 'test-version',
  imageDigest: 'test-image',
  policyDigest: 'test-policy',
  adapterDigest: 'test-adapter',
};
function report() {
  return {
    ...expected,
    schemaVersion: 1,
    startedAt: '2026-09-20T11:00:00Z',
    expiresAt: '2026-09-20T13:00:00Z',
    results: scenarios.map((scenario: string) => ({
      scenario,
      status: 'passed',
      evidenceKind: 'runtime',
      evidenceRef: `test-artifacts/${scenario}`,
    })),
  };
}

describe('worker canary readiness evidence', () => {
  it.each(['claude', 'codex', 'opencode'])(
    'graduates %s independently',
    (provider) => {
      expect(
        evaluate({ ...report(), provider }, { ...expected, provider }, now)
          .ready,
      ).toBe(true);
    },
  );

  it.each([
    'provider',
    'providerVersion',
    'imageDigest',
    'policyDigest',
    'adapterDigest',
  ])('rejects stale %s', (key) => {
    expect(
      evaluate({ ...report(), [key]: 'different' }, expected, now).ready,
    ).toBe(false);
  });

  it.each(['failed', 'skipped', 'unknown'])(
    'refuses %s mandatory evidence',
    (status) => {
      const input = report();
      input.results[0].status = status;
      expect(evaluate(input, expected, now).ready).toBe(false);
    },
  );

  it('does not confuse advisory or config evidence with executable enforcement', () => {
    for (const evidenceKind of ['advisory', 'configuration', 'unit']) {
      const input = report();
      input.results[0].evidenceKind = evidenceKind;
      expect(evaluate(input, expected, now).ready).toBe(false);
    }
  });

  it('requires every scenario exactly once and retained evidence', () => {
    const input = report();
    input.results.pop();
    expect(evaluate(input, expected, now).ready).toBe(false);
    input.results.push(input.results[0]);
    expect(evaluate(input, expected, now).ready).toBe(false);
    const missingRef = report();
    missingRef.results[0].evidenceRef = '';
    expect(evaluate(missingRef, expected, now).ready).toBe(false);
  });

  it('rejects malformed, expired and future reports', () => {
    for (const input of [
      null,
      [],
      {},
      { ...report(), schemaVersion: 2 },
      { ...report(), expiresAt: '2026-09-20T12:00:00Z' },
      { ...report(), startedAt: '2026-09-21T12:00:00Z' },
    ]) {
      expect(evaluate(input, expected, now).ready).toBe(false);
    }
  });
});
