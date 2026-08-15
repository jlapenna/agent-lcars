import { describe, expect, it } from 'vitest';

import { runBindingSchema } from './attempt';
import {
  canonicalDurableJson,
  DurabilityCapacityError,
  LIFECYCLE_DURABILITY_LIMITS,
  lifecycleDurabilityLimitsSchema,
  normalizeDurableValue,
  serializedDurableByteLength,
  UnsupportedDurableValueError,
  validateDurablePage,
  validateDurableTransition,
  validateDurableValue,
} from './durability';
import { canonicalTaskIdentitySchema, tenantRefSchema } from './identity';
import {
  DURABLE_SCALAR_BYTE_LIMITS,
  utf8ByteLength,
  utf8ByteLimitedStringSchema,
} from './primitives';

function serializedStringOfBytes(bytes: number): string {
  const contentBytes = bytes - 2;
  const emojiCount = Math.floor(contentBytes / 4);
  const asciiCount = contentBytes - emojiCount * 4;
  return `${'🙂'.repeat(emojiCount)}${'a'.repeat(asciiCount)}`;
}

function utf8StringOfBytes(bytes: number): string {
  const emojiCount = Math.floor(bytes / 4);
  const asciiCount = bytes - emojiCount * 4;
  return `${'🙂'.repeat(emojiCount)}${'a'.repeat(asciiCount)}`;
}

const documentHardCeilingBytes = 1_048_576;
const atomicRequestHardCeilingBytes = 10 * documentHardCeilingBytes;

describe('LifecycleDurabilityLimits', () => {
  it('is a finite versioned contract with provider headroom', () => {
    expect(
      lifecycleDurabilityLimitsSchema.safeParse(LIFECYCLE_DURABILITY_LIMITS)
        .success,
    ).toBe(true);
    expect(Object.isFrozen(LIFECYCLE_DURABILITY_LIMITS)).toBe(true);
    expect(Object.isFrozen(LIFECYCLE_DURABILITY_LIMITS.scalarBytes)).toBe(true);
    expect(LIFECYCLE_DURABILITY_LIMITS.taskHeadBytes).toBeLessThan(
      documentHardCeilingBytes,
    );
    expect(LIFECYCLE_DURABILITY_LIMITS.attemptHeadBytes).toBeLessThan(
      documentHardCeilingBytes,
    );
    expect(LIFECYCLE_DURABILITY_LIMITS.transitionBytes).toBeLessThan(
      atomicRequestHardCeilingBytes,
    );
    expect(
      lifecycleDurabilityLimitsSchema.safeParse({
        ...LIFECYCLE_DURABILITY_LIMITS,
        taskHeadBytes: documentHardCeilingBytes,
      }).success,
    ).toBe(false);
  });

  it('counts UTF-8 bytes and accepts exact serialized boundaries only', () => {
    const limit = LIFECYCLE_DURABILITY_LIMITS.historyRecordBytes;
    const exact = serializedStringOfBytes(limit);
    expect(serializedDurableByteLength(exact)).toBe(limit);
    expect(validateDurableValue(exact, 'historyRecordBytes')).toBe(exact);
    expect(() =>
      validateDurableValue(`${exact}x`, 'historyRecordBytes'),
    ).toThrow(DurabilityCapacityError);

    const multibyte = '🙂'.repeat(12);
    expect(utf8ByteLength(multibyte)).toBe(48);
    expect(utf8ByteLength(`${multibyte}a`)).toBe(49);
  });

  it('normalizes key order and rejects values that are not durable JSON', () => {
    expect(canonicalDurableJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":2}',
    );
    expect(normalizeDurableValue({ b: 2, a: 1 })).toEqual({ a: 1, b: 2 });

    const unsupportedValues: unknown[] = [
      undefined,
      { value: undefined },
      [undefined],
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date('2026-01-01'),
      new Map([['secret', 'value']]),
    ];
    for (const value of unsupportedValues) {
      expect(() => canonicalDurableJson(value)).toThrow(
        UnsupportedDurableValueError,
      );
    }
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalDurableJson(cyclic)).toThrow(
      UnsupportedDurableValueError,
    );
    const shared = { durable: true };
    expect(() =>
      canonicalDurableJson({ first: shared, second: shared }),
    ).toThrow(UnsupportedDurableValueError);
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        throw new Error('raw provider body');
      },
    });
    expect(() => canonicalDurableJson(accessor)).toThrow(
      UnsupportedDurableValueError,
    );
    const symbolKey = { visible: true } as Record<string | symbol, unknown>;
    symbolKey[Symbol('ignored')] = 'must not be ignored';
    expect(() => canonicalDurableJson(symbolKey)).toThrow(
      UnsupportedDurableValueError,
    );
    const nonEnumerable = Object.defineProperty({}, 'hidden', {
      enumerable: false,
      value: true,
    });
    expect(() => canonicalDurableJson(nonEnumerable)).toThrow(
      UnsupportedDurableValueError,
    );
    const extraArrayProperty: unknown[] = [];
    Object.defineProperty(extraArrayProperty, '01', {
      enumerable: true,
      value: 'not canonical',
    });
    expect(() => canonicalDurableJson(extraArrayProperty)).toThrow(
      UnsupportedDurableValueError,
    );
    const prototypeKey = JSON.parse(
      '{"__proto__":{"polluted":true},"safe":1}',
    ) as unknown;
    expect(canonicalDurableJson(prototypeKey)).toBe(
      '{"__proto__":{"polluted":true},"safe":1}',
    );
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects nesting beyond the closed depth budget', () => {
    let exact: unknown = 'leaf';
    for (
      let depth = 0;
      depth < LIFECYCLE_DURABILITY_LIMITS.maxNestingDepth;
      depth += 1
    ) {
      exact = { value: exact };
    }
    expect(() => canonicalDurableJson(exact)).not.toThrow();
    expect(() => canonicalDurableJson({ value: exact })).toThrow(
      DurabilityCapacityError,
    );
  });

  it('rejects oversized container breadth before materializing it', () => {
    expect(() =>
      canonicalDurableJson(
        Array.from({
          length: LIFECYCLE_DURABILITY_LIMITS.maxContainerItems + 1,
        }),
      ),
    ).toThrow(DurabilityCapacityError);
    expect(() => utf8ByteLimitedStringSchema(Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
  });

  it('checks page count/bytes and transition fan-out as complete units', () => {
    expect(validateDurablePage([{ b: 2 }, { a: 1 }]).items).toEqual([
      { b: 2 },
      { a: 1 },
    ]);
    expect(() =>
      validateDurablePage(
        Array.from({ length: LIFECYCLE_DURABILITY_LIMITS.pageItemCount + 1 }),
      ),
    ).toThrow(DurabilityCapacityError);
    expect(() =>
      validateDurableTransition({
        effects: Array.from({
          length: LIFECYCLE_DURABILITY_LIMITS.transitionEffectCount + 1,
        }),
        historyRecords: [],
        workRecords: [],
      }),
    ).toThrow(DurabilityCapacityError);
    const result = validateDurableTransition({
      effects: [{ kind: 'effect' }],
      historyRecords: [{ kind: 'record' }],
      workRecords: [{ kind: 'work' }],
    });
    expect(result.transition.historyRecords).toEqual([{ kind: 'record' }]);
    expect(result.bytes).toBe(serializedDurableByteLength(result.transition));
  });

  it('enforces UTF-8 scalar boundaries on repository and task metadata', () => {
    const owner = '🙂'.repeat(62);
    const exactRepository = `${owner}/🙂aaa`;
    expect(utf8ByteLength(exactRepository)).toBe(
      DURABLE_SCALAR_BYTE_LIMITS.repository,
    );
    expect(
      tenantRefSchema.safeParse({
        tenantId: 'tenant',
        repositoryId: 1,
        repository: exactRepository,
        installationId: 2,
      }).success,
    ).toBe(true);
    expect(
      tenantRefSchema.safeParse({
        tenantId: 'tenant',
        repositoryId: 1,
        repository: `${exactRepository}a`,
        installationId: 2,
      }).success,
    ).toBe(false);
    expect(
      canonicalTaskIdentitySchema.safeParse({
        tenantId: 'tenant',
        repositoryId: 1,
        issueNumber: 2,
      }).success,
    ).toBe(true);

    const pathPrefix = '.github/workflows/';
    const exactPath = `${pathPrefix}${utf8StringOfBytes(
      DURABLE_SCALAR_BYTE_LIMITS.workflowPath - utf8ByteLength(pathPrefix),
    )}`;
    expect(utf8ByteLength(exactPath)).toBe(
      DURABLE_SCALAR_BYTE_LIMITS.workflowPath,
    );
    const exactRef = utf8StringOfBytes(DURABLE_SCALAR_BYTE_LIMITS.workflowRef);
    const binding = {
      runId: 1,
      runAttempt: 1,
      checkRunId: 2,
      workflowPath: exactPath,
      workflowRef: exactRef,
      workflowSha: 'a'.repeat(40),
    };
    expect(runBindingSchema.safeParse(binding).success).toBe(true);
    expect(
      runBindingSchema.safeParse({
        ...binding,
        workflowPath: `${exactPath}a`,
      }).success,
    ).toBe(false);
    expect(
      runBindingSchema.safeParse({
        ...binding,
        workflowRef: `${exactRef}a`,
      }).success,
    ).toBe(false);
  });
});
