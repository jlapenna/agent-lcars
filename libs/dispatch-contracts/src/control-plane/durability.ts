import { z } from 'zod';

/** Reference provider ceilings; kept private to preserve provider neutrality. */
const DOCUMENT_HARD_CEILING_BYTES = 1_048_576;
const ATOMIC_REQUEST_HARD_CEILING_BYTES = 10 * 1_048_576;

/**
 * Server-owned budgets for the lifecycle history split. These are wire
 * budgets, not caller configuration and must not be used to truncate an
 * existing aggregate. The byte choices leave substantial room for provider
 * envelopes, indexes, and future fields below Firestore's ceilings.
 */
export const LIFECYCLE_DURABILITY_LIMITS = Object.freeze({
  schema: 'agent-lcars.lifecycle-durability-limits/v1',
  version: 1,
  historyRecordBytes: 64 * 1_024,
  taskHeadBytes: 512 * 1_024,
  attemptHeadBytes: 512 * 1_024,
  replayReceiptBytes: 128 * 1_024,
  pageBytes: 256 * 1_024,
  pageItemCount: 100,
  transitionBytes: 512 * 1_024,
  transitionEffectCount: 32,
  transitionHistoryRecordCount: 64,
  transitionWorkRecordCount: 32,
  maxNestingDepth: 16,
  maxContainerItems: 512,
  scalarBytes: Object.freeze({
    repository: 256,
    workflowPath: 512,
    workflowRef: 1_024,
    jobWorkflowRef: 2_048,
  }),
} as const);

export type LifecycleDurabilityLimits = Readonly<
  typeof LIFECYCLE_DURABILITY_LIMITS
>;

export const lifecycleDurabilityLimitsSchema = z
  .strictObject({
    schema: z.literal('agent-lcars.lifecycle-durability-limits/v1'),
    version: z.literal(1),
    historyRecordBytes: z.literal(
      LIFECYCLE_DURABILITY_LIMITS.historyRecordBytes,
    ),
    taskHeadBytes: z.literal(LIFECYCLE_DURABILITY_LIMITS.taskHeadBytes),
    attemptHeadBytes: z.literal(LIFECYCLE_DURABILITY_LIMITS.attemptHeadBytes),
    replayReceiptBytes: z.literal(
      LIFECYCLE_DURABILITY_LIMITS.replayReceiptBytes,
    ),
    pageBytes: z.literal(LIFECYCLE_DURABILITY_LIMITS.pageBytes),
    pageItemCount: z.literal(LIFECYCLE_DURABILITY_LIMITS.pageItemCount),
    transitionBytes: z.literal(LIFECYCLE_DURABILITY_LIMITS.transitionBytes),
    transitionEffectCount: z.literal(
      LIFECYCLE_DURABILITY_LIMITS.transitionEffectCount,
    ),
    transitionHistoryRecordCount: z.literal(
      LIFECYCLE_DURABILITY_LIMITS.transitionHistoryRecordCount,
    ),
    transitionWorkRecordCount: z.literal(
      LIFECYCLE_DURABILITY_LIMITS.transitionWorkRecordCount,
    ),
    maxNestingDepth: z.literal(LIFECYCLE_DURABILITY_LIMITS.maxNestingDepth),
    maxContainerItems: z.literal(LIFECYCLE_DURABILITY_LIMITS.maxContainerItems),
    scalarBytes: z.strictObject({
      repository: z.literal(LIFECYCLE_DURABILITY_LIMITS.scalarBytes.repository),
      workflowPath: z.literal(
        LIFECYCLE_DURABILITY_LIMITS.scalarBytes.workflowPath,
      ),
      workflowRef: z.literal(
        LIFECYCLE_DURABILITY_LIMITS.scalarBytes.workflowRef,
      ),
      jobWorkflowRef: z.literal(
        LIFECYCLE_DURABILITY_LIMITS.scalarBytes.jobWorkflowRef,
      ),
    }),
  })
  .superRefine((limits, ctx) => {
    for (const field of [
      'historyRecordBytes',
      'taskHeadBytes',
      'attemptHeadBytes',
      'replayReceiptBytes',
      'pageBytes',
    ] as const) {
      if (limits[field] >= DOCUMENT_HARD_CEILING_BYTES) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'Durability budget must leave document headroom',
        });
      }
    }
    if (limits.transitionBytes >= ATOMIC_REQUEST_HARD_CEILING_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['transitionBytes'],
        message: 'Transition budget must leave atomic request headroom',
      });
    }
  });

export type DurableJsonValue =
  | null
  | boolean
  | number
  | string
  | DurableJsonValue[]
  | { [key: string]: DurableJsonValue };

export type DurabilityByteBudget =
  | 'historyRecordBytes'
  | 'taskHeadBytes'
  | 'attemptHeadBytes'
  | 'replayReceiptBytes'
  | 'pageBytes'
  | 'transitionBytes';

export type DurabilityCountBudget =
  | 'pageItemCount'
  | 'transitionEffectCount'
  | 'transitionHistoryRecordCount'
  | 'transitionWorkRecordCount'
  | 'maxNestingDepth'
  | 'maxContainerItems';

export type DurabilityCapacityUnit = 'bytes' | 'items';

/** A generic, typed capacity failure that never contains the rejected value. */
export class DurabilityCapacityError extends Error {
  override readonly name = 'DurabilityCapacityError';
  readonly limit: DurabilityByteBudget | DurabilityCountBudget;
  readonly actual: number;
  readonly maximum: number;
  readonly unit: DurabilityCapacityUnit;

  constructor(
    limit: DurabilityByteBudget | DurabilityCountBudget,
    actual: number,
    maximum: number,
    unit: DurabilityCapacityUnit,
  ) {
    super(`Durable ${limit} capacity exceeded (${actual} ${unit})`);
    this.limit = limit;
    this.actual = actual;
    this.maximum = maximum;
    this.unit = unit;
  }
}

/** Raised before sizing when a value cannot be represented as durable JSON. */
export class UnsupportedDurableValueError extends TypeError {
  override readonly name = 'UnsupportedDurableValueError';

  constructor() {
    super('Durable value is not supported JSON');
  }
}

function unsupported(): never {
  throw new UnsupportedDurableValueError();
}

/**
 * Normalize a durable value into deterministic JSON-compatible data. Objects
 * are sorted by key and copied, while undefined, non-finite numbers, class
 * instances, and cyclic values are rejected before any size is returned.
 */
export function normalizeDurableValue(value: unknown): DurableJsonValue {
  // Durable JSON has no object-identity or aliasing semantics. Rejecting a
  // repeated identity also prevents a shallow shared-reference DAG from
  // expanding exponentially before the final byte budget can be checked.
  const seen = new Set<object>();

  function normalize(current: unknown, depth: number): DurableJsonValue {
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean'
    ) {
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) unsupported();
      return current;
    }
    if (typeof current !== 'object') unsupported();
    if (seen.has(current)) unsupported();
    const nextDepth = depth + 1;
    if (nextDepth > LIFECYCLE_DURABILITY_LIMITS.maxNestingDepth) {
      throw new DurabilityCapacityError(
        'maxNestingDepth',
        nextDepth,
        LIFECYCLE_DURABILITY_LIMITS.maxNestingDepth,
        'items',
      );
    }
    const maximumItems = LIFECYCLE_DURABILITY_LIMITS.maxContainerItems;
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length > maximumItems) {
        throw new DurabilityCapacityError(
          'maxContainerItems',
          current.length,
          maximumItems,
          'items',
        );
      }
      const ownNames = Object.getOwnPropertyNames(current);
      const expectedNames = new Set([
        'length',
        ...Array.from({ length: current.length }, (_, index) => `${index}`),
      ]);
      if (
        Object.getOwnPropertySymbols(current).length > 0 ||
        ownNames.some((key) => !expectedNames.has(key)) ||
        ownNames.length !== expectedNames.size
      ) {
        unsupported();
      }
      const result: DurableJsonValue[] = [];
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, `${index}`);
        if (descriptor === undefined || !('value' in descriptor)) {
          unsupported();
        }
        result.push(normalize(descriptor.value, nextDepth));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) unsupported();
    const ownNames = Object.getOwnPropertyNames(current);
    const enumerableNames = Object.keys(current);
    if (ownNames.length > maximumItems) {
      throw new DurabilityCapacityError(
        'maxContainerItems',
        ownNames.length,
        maximumItems,
        'items',
      );
    }
    if (
      Object.getOwnPropertySymbols(current).length > 0 ||
      ownNames.length !== enumerableNames.length
    ) {
      unsupported();
    }
    const result: { [key: string]: DurableJsonValue } = {};
    for (const key of enumerableNames.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        unsupported();
      }
      // Defining the property avoids the legacy `__proto__` setter on a
      // normal object. Assignment would silently change the clone's
      // prototype and omit an input field from canonical JSON.
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: normalize(descriptor.value, nextDepth),
        writable: true,
      });
    }
    return result;
  }

  try {
    return normalize(value, 0);
  } catch (error) {
    if (
      error instanceof UnsupportedDurableValueError ||
      error instanceof DurabilityCapacityError
    ) {
      throw error;
    }
    throw new UnsupportedDurableValueError();
  }
}

/** Canonical JSON text used for all durable size and digest calculations. */
export function canonicalDurableJson(value: unknown): string {
  const encoded = JSON.stringify(normalizeDurableValue(value));
  if (encoded === undefined) unsupported();
  return encoded;
}

export function serializedDurableByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalDurableJson(value)).byteLength;
}

/** Validate and return the complete normalized value, never a partial result. */
export function validateDurableValue(
  value: unknown,
  limit: DurabilityByteBudget,
): DurableJsonValue {
  const normalized = normalizeDurableValue(value);
  const bytes = serializedDurableByteLength(normalized);
  const maximum = LIFECYCLE_DURABILITY_LIMITS[limit];
  if (bytes > maximum) {
    throw new DurabilityCapacityError(limit, bytes, maximum, 'bytes');
  }
  return normalized;
}

export interface DurablePageValidationResult {
  readonly items: DurableJsonValue[];
  readonly bytes: number;
}

/** Validate one complete bounded page, including count and serialized bytes. */
export function validateDurablePage(
  items: readonly unknown[],
): DurablePageValidationResult {
  const maximumItems = LIFECYCLE_DURABILITY_LIMITS.pageItemCount;
  if (items.length > maximumItems) {
    throw new DurabilityCapacityError(
      'pageItemCount',
      items.length,
      maximumItems,
      'items',
    );
  }
  const normalized = items.map(normalizeDurableValue);
  const bytes = serializedDurableByteLength(normalized);
  const maximumBytes = LIFECYCLE_DURABILITY_LIMITS.pageBytes;
  if (bytes > maximumBytes) {
    throw new DurabilityCapacityError(
      'pageBytes',
      bytes,
      maximumBytes,
      'bytes',
    );
  }
  return { items: normalized, bytes };
}

export interface DurableTransitionInput {
  readonly effects: readonly unknown[];
  readonly historyRecords: readonly unknown[];
  readonly workRecords: readonly unknown[];
}

export interface DurableTransitionValidationResult {
  readonly transition: {
    readonly effects: DurableJsonValue[];
    readonly historyRecords: DurableJsonValue[];
    readonly workRecords: DurableJsonValue[];
  };
  readonly bytes: number;
}

/** Validate all transition fan-out atomically, without dropping any record. */
export function validateDurableTransition(
  input: DurableTransitionInput,
): DurableTransitionValidationResult {
  const limits = LIFECYCLE_DURABILITY_LIMITS;
  if (input.effects.length > limits.transitionEffectCount) {
    throw new DurabilityCapacityError(
      'transitionEffectCount',
      input.effects.length,
      limits.transitionEffectCount,
      'items',
    );
  }
  if (input.historyRecords.length > limits.transitionHistoryRecordCount) {
    throw new DurabilityCapacityError(
      'transitionHistoryRecordCount',
      input.historyRecords.length,
      limits.transitionHistoryRecordCount,
      'items',
    );
  }
  if (input.workRecords.length > limits.transitionWorkRecordCount) {
    throw new DurabilityCapacityError(
      'transitionWorkRecordCount',
      input.workRecords.length,
      limits.transitionWorkRecordCount,
      'items',
    );
  }
  const transition = {
    effects: input.effects.map(normalizeDurableValue),
    historyRecords: input.historyRecords.map((record) =>
      validateDurableValue(record, 'historyRecordBytes'),
    ),
    workRecords: input.workRecords.map(normalizeDurableValue),
  };
  const bytes = serializedDurableByteLength(transition);
  if (bytes > limits.transitionBytes) {
    throw new DurabilityCapacityError(
      'transitionBytes',
      bytes,
      limits.transitionBytes,
      'bytes',
    );
  }
  return { transition, bytes };
}

// Explicit names for callers that prefer assertion-style vocabulary.
export const assertDurableValueWithinLimit = validateDurableValue;
export const serializedRecordByteLength = serializedDurableByteLength;
