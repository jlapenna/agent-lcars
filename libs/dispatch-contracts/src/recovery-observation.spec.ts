import { describe, expect, it } from 'vitest';

import {
  buildRecoveryObservation,
  formatOperationKey,
  isRecoveryDomain,
  isRecoverySourceKind,
  isWellFormedRecoveryObservation,
  parseOperationKey,
  RECOVERY_DOMAINS,
  RECOVERY_SOURCE_KINDS,
  type RecoveryOperationTarget,
} from './recovery-observation';

function targetFixture(
  overrides: Partial<RecoveryOperationTarget> = {},
): RecoveryOperationTarget {
  return {
    domain: 'pr_healing',
    repositoryId: 42,
    repository: 'supersprinklesracing/sprinkles',
    anchor: 4321,
    exactIdentity: 'pr:4321:abc123',
    ...overrides,
  };
}

describe('isRecoveryDomain / isRecoverySourceKind', () => {
  it('accepts every declared domain and source kind', () => {
    for (const domain of RECOVERY_DOMAINS) {
      expect(isRecoveryDomain(domain)).toBe(true);
    }
    for (const sourceKind of RECOVERY_SOURCE_KINDS) {
      expect(isRecoverySourceKind(sourceKind)).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(isRecoveryDomain('ci_rerun')).toBe(false);
    expect(isRecoveryDomain(undefined)).toBe(false);
    expect(isRecoverySourceKind('cron')).toBe(false);
    expect(isRecoverySourceKind(undefined)).toBe(false);
  });
});

describe('formatOperationKey / parseOperationKey', () => {
  it('round-trips a well-formed target through format and parse', () => {
    const target = targetFixture();
    const key = formatOperationKey(target);
    expect(key).toBe('recovery/v1:pr_healing:42:4321:pr:4321:abc123');
    expect(parseOperationKey(key)).toEqual({
      domain: 'pr_healing',
      repositoryId: 42,
      repository: '',
      anchor: 4321,
      exactIdentity: 'pr:4321:abc123',
    });
  });

  it('produces the identical key for two independent observations of the same fact', () => {
    const a = formatOperationKey(targetFixture());
    const b = formatOperationKey(targetFixture());
    expect(a).toBe(b);
  });

  it('produces different keys when the exact identity differs', () => {
    const a = formatOperationKey(
      targetFixture({ exactIdentity: 'pr:4321:abc123' }),
    );
    const b = formatOperationKey(
      targetFixture({ exactIdentity: 'pr:4321:def456' }),
    );
    expect(a).not.toBe(b);
  });

  it('rejects an unknown domain', () => {
    expect(() =>
      formatOperationKey(targetFixture({ domain: 'ci_rerun' as never })),
    ).toThrow(/Unknown recovery domain/);
  });

  it('rejects a negative or non-integer repositoryId or anchor', () => {
    expect(() =>
      formatOperationKey(targetFixture({ repositoryId: -1 })),
    ).toThrow(/Invalid repositoryId/);
    expect(() => formatOperationKey(targetFixture({ anchor: 1.5 }))).toThrow(
      /Invalid anchor/,
    );
  });

  it('rejects an empty exact identity', () => {
    expect(() =>
      formatOperationKey(targetFixture({ exactIdentity: '' })),
    ).toThrow(/exactIdentity/);
  });

  it('parses an exact identity that itself contains colons', () => {
    const target = targetFixture({
      domain: 'ci_retry',
      exactIdentity: 'run:987654:2',
    });
    const key = formatOperationKey(target);
    expect(parseOperationKey(key)?.exactIdentity).toBe('run:987654:2');
  });

  it('returns undefined for a malformed or foreign key', () => {
    expect(parseOperationKey(undefined)).toBeUndefined();
    expect(parseOperationKey(null)).toBeUndefined();
    expect(parseOperationKey('')).toBeUndefined();
    expect(parseOperationKey('not-a-recovery-key')).toBeUndefined();
    expect(
      parseOperationKey('recovery/v1:unknown_domain:1:2:x'),
    ).toBeUndefined();
    expect(parseOperationKey('recovery/v2:pr_healing:1:2:x')).toBeUndefined();
  });
});

describe('buildRecoveryObservation / isWellFormedRecoveryObservation', () => {
  function observationFixture() {
    return buildRecoveryObservation({
      target: targetFixture(),
      sourceKind: 'webhook',
      observedAt: '2026-08-09T00:00:00.000Z',
      evidence:
        'https://github.com/supersprinklesracing/sprinkles/pull/4321#issuecomment-1',
    });
  }

  it('derives operationKey from target so the two cannot disagree', () => {
    const observation = observationFixture();
    expect(observation.operationKey).toBe(
      formatOperationKey(observation.target),
    );
  });

  it('accepts a well-formed observation for every domain and source kind', () => {
    for (const domain of RECOVERY_DOMAINS) {
      for (const sourceKind of RECOVERY_SOURCE_KINDS) {
        const observation = buildRecoveryObservation({
          target: targetFixture({ domain }),
          sourceKind,
          observedAt: '2026-08-09T00:00:00.000Z',
          evidence: 'https://example.invalid/evidence',
        });
        expect(isWellFormedRecoveryObservation(observation)).toBe(true);
      }
    }
  });

  it('rejects an unknown source kind', () => {
    expect(() =>
      buildRecoveryObservation({
        target: targetFixture(),
        sourceKind: 'cron' as never,
        observedAt: '2026-08-09T00:00:00.000Z',
        evidence: 'https://example.invalid/evidence',
      }),
    ).toThrow(/Unknown recovery source kind/);
  });

  it('rejects an empty observedAt or evidence', () => {
    expect(() =>
      buildRecoveryObservation({
        target: targetFixture(),
        sourceKind: 'webhook',
        observedAt: '',
        evidence: 'https://example.invalid/evidence',
      }),
    ).toThrow(/observedAt/);
    expect(() =>
      buildRecoveryObservation({
        target: targetFixture(),
        sourceKind: 'webhook',
        observedAt: '2026-08-09T00:00:00.000Z',
        evidence: '',
      }),
    ).toThrow(/evidence/);
  });

  it('rejects a non-object', () => {
    expect(isWellFormedRecoveryObservation(undefined)).toBe(false);
    expect(isWellFormedRecoveryObservation(null)).toBe(false);
    expect(isWellFormedRecoveryObservation('x')).toBe(false);
    expect(isWellFormedRecoveryObservation([])).toBe(false);
  });

  it('rejects an observation whose operationKey does not match its target', () => {
    const observation = observationFixture();
    expect(
      isWellFormedRecoveryObservation({
        ...observation,
        operationKey: 'recovery/v1:pr_healing:42:4321:tampered',
      }),
    ).toBe(false);
  });

  it('rejects a target with an unknown domain or out-of-range numbers', () => {
    const observation = observationFixture();
    expect(
      isWellFormedRecoveryObservation({
        ...observation,
        target: { ...observation.target, domain: 'ci_rerun' },
      }),
    ).toBe(false);
    expect(
      isWellFormedRecoveryObservation({
        ...observation,
        target: { ...observation.target, repositoryId: -1 },
      }),
    ).toBe(false);
    expect(
      isWellFormedRecoveryObservation({
        ...observation,
        target: { ...observation.target, anchor: 1.5 },
      }),
    ).toBe(false);
  });

  it('rejects a non-string detail', () => {
    const observation = observationFixture();
    expect(
      isWellFormedRecoveryObservation({ ...observation, detail: 42 }),
    ).toBe(false);
  });

  it('accepts an observation carrying a string detail', () => {
    const observation = buildRecoveryObservation({
      target: targetFixture(),
      sourceKind: 'poll',
      observedAt: '2026-08-09T00:00:00.000Z',
      evidence: 'https://example.invalid/evidence',
      detail: 'discovered during scheduled sweep',
    });
    expect(isWellFormedRecoveryObservation(observation)).toBe(true);
  });
});
