import { describe, expect, it } from 'vitest';

import {
  DurabilityCapacityError,
  LIFECYCLE_DURABILITY_LIMITS,
  serializedDurableByteLength,
} from './durability';
import {
  appendHistoryRecord,
  assertIdempotencyCompatible,
  canonicalReplayInputDigest,
  createGenesisHistoryHead,
  createHistoryRecord,
  createIdempotencyTombstone,
  createReplayReceipt,
  HISTORY_AGGREGATE_KINDS,
  historyHeadSchema,
  HistoryIntegrityError,
  historyPayloadDigest,
  historyRecordReference,
  replayReceiptSchema,
  sha256Digest,
  verifyHistoryAppend,
  verifyHistoryChain,
  verifyHistoryRecord,
  verifyHistoryRecordPayload,
  verifyReplayReceipt,
  verifyReplayReceiptReferences,
} from './history';

const identity = {
  tenantId: 'tenant-a',
  aggregateKind: 'task' as const,
  aggregateId: 'task-1',
  streamKind: 'fact' as const,
};

describe('immutable lifecycle history primitives', () => {
  it('creates an explicit genesis and evolves an exact cursor/hash chain', () => {
    const genesis = createGenesisHistoryHead(identity);
    const first = appendHistoryRecord({
      head: genesis,
      payload: { b: 2, a: 1 },
      appliedRevision: 1,
    });
    const second = appendHistoryRecord({
      head: first.head,
      payload: { event: 'second' },
      appliedRevision: 2,
    });

    expect(genesis).toMatchObject({
      count: 0,
      lastSequence: 0,
      headDigest: null,
    });
    expect(first.record).toMatchObject({
      sequence: 1,
      previousRecordDigest: null,
    });
    expect(second.record).toMatchObject({
      sequence: 2,
      previousRecordDigest: first.record.recordDigest,
    });
    expect(
      verifyHistoryChain([first.record, second.record], second.head),
    ).toEqual(second.head);
    expect(Object.isFrozen(second.head)).toBe(true);
    expect(Object.isFrozen(second.record)).toBe(true);
  });

  it('rejects stale, reordered, substituted, and tampered appends', () => {
    const genesis = createGenesisHistoryHead(identity);
    const first = appendHistoryRecord({
      head: genesis,
      payload: 'one',
      appliedRevision: 1,
    });
    const second = appendHistoryRecord({
      head: first.head,
      payload: 'two',
      appliedRevision: 2,
    });

    expect(() =>
      verifyHistoryAppend({ head: genesis, record: second.record }),
    ).toThrow(HistoryIntegrityError);
    expect(() =>
      verifyHistoryAppend({
        head: first.head,
        record: { ...second.record, tenantId: 'foreign' },
      }),
    ).toThrow(HistoryIntegrityError);
    expect(() =>
      verifyHistoryRecord({
        ...first.record,
        payloadDigest: historyPayloadDigest('changed'),
      }),
    ).toThrow(HistoryIntegrityError);
    expect(() => verifyHistoryRecord({ ...first.record, sequence: 2 })).toThrow(
      HistoryIntegrityError,
    );
    expect(() =>
      verifyHistoryAppend({
        head: first.head,
        record: { ...second.record, previousRecordDigest: '0'.repeat(64) },
      }),
    ).toThrow(HistoryIntegrityError);
    expect(() =>
      verifyHistoryAppend({ head: first.head, record: first.record }),
    ).toThrow(HistoryIntegrityError);
    expect(() =>
      verifyHistoryAppend({
        head: first.head,
        record: { ...second.record, sequence: 3 },
      }),
    ).toThrow(HistoryIntegrityError);
    expect(() =>
      verifyHistoryAppend({
        head: first.head,
        record: { ...second.record, aggregateId: 'foreign' },
      }),
    ).toThrow(HistoryIntegrityError);
    expect(() =>
      verifyHistoryAppend({
        head: first.head,
        record: { ...second.record, aggregateKind: 'attempt' },
      }),
    ).toThrow(HistoryIntegrityError);
    expect(() =>
      verifyHistoryAppend({
        head: first.head,
        record: { ...second.record, streamKind: 'command' },
      }),
    ).toThrow(HistoryIntegrityError);
    expect(() =>
      verifyHistoryRecord({
        ...first.record,
        payloadDigest: historyPayloadDigest({ changed: true }),
      }),
    ).toThrow(HistoryIntegrityError);
  });

  it('permits equal or jumping revisions, rejects regressions, and stops at safe-integer sequence limits', () => {
    const genesis = createGenesisHistoryHead(identity);
    const jumped = appendHistoryRecord({
      head: genesis,
      payload: 'jumped',
      appliedRevision: 99,
    });
    expect(jumped.head.lastAppliedRevision).toBe(99);
    const equal = appendHistoryRecord({
      head: jumped.head,
      payload: 'equal-revision',
      appliedRevision: 99,
    });
    expect(equal.head.lastAppliedRevision).toBe(99);
    expect(() =>
      appendHistoryRecord({
        head: equal.head,
        payload: 'older',
        appliedRevision: 98,
      }),
    ).toThrow(HistoryIntegrityError);

    const terminal = {
      ...jumped.head,
      count: Number.MAX_SAFE_INTEGER,
      lastSequence: Number.MAX_SAFE_INTEGER,
    };
    expect(() =>
      appendHistoryRecord({
        head: terminal,
        payload: 'overflow',
        appliedRevision: 100,
      }),
    ).toThrow(HistoryIntegrityError);
    expect(() =>
      verifyHistoryAppend({ head: terminal, record: jumped.record }),
    ).toThrow(HistoryIntegrityError);
    expect(
      historyHeadSchema.safeParse({
        ...jumped.head,
        lastAppliedRevision: 0,
      }).success,
    ).toBe(false);
    expect(() =>
      createHistoryRecord({
        ...identity,
        sequence: 0,
        previousRecordDigest: null,
        payload: 'invalid-sequence',
        appliedRevision: 1,
      }),
    ).toThrow(HistoryIntegrityError);
    expect(() =>
      createHistoryRecord({
        ...identity,
        sequence: 1,
        previousRecordDigest: '0'.repeat(64),
        payload: 'invalid-genesis',
        appliedRevision: 1,
      }),
    ).toThrow(HistoryIntegrityError);
  });

  it('is key-order stable and separates aggregate namespaces', () => {
    expect(sha256Digest('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Digest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Digest('🙂')).toBe(
      'd06f1525f791397809f9bc98682b5c13318eca4c3123433467fd4dffda44fd14',
    );
    expect(historyPayloadDigest({ b: 2, a: 1 })).toBe(
      historyPayloadDigest({ a: 1, b: 2 }),
    );
    const task = createHistoryRecord({
      ...identity,
      sequence: 1,
      previousRecordDigest: null,
      payload: { same: true },
      appliedRevision: 1,
    });
    const attempt = createHistoryRecord({
      ...identity,
      aggregateKind: 'attempt',
      sequence: 1,
      previousRecordDigest: null,
      payload: { same: true },
      appliedRevision: 1,
    });
    expect(task.recordDigest).not.toBe(attempt.recordDigest);
    expect(HISTORY_AGGREGATE_KINDS).toEqual(['task', 'attempt']);
  });

  it('keeps replay receipts compact and verifies exact references', () => {
    const head = createGenesisHistoryHead(identity);
    const appended = appendHistoryRecord({
      head,
      payload: { result: 'ok' },
      appliedRevision: 1,
    });
    const ref = historyRecordReference(appended.record);
    expect(ref.schema).toBe(
      'agent-lcars.lifecycle-history-record-reference/v1',
    );
    expect(ref.schema).not.toBe(appended.record.schema);
    const receipt = createReplayReceipt({
      operationId: 'operation-1',
      replayKey: 'replay-1',
      tenantId: identity.tenantId,
      aggregateKind: identity.aggregateKind,
      aggregateId: identity.aggregateId,
      canonicalInputDigest: '1'.repeat(64),
      appliedRevision: 1,
      responseRecordRefs: [ref],
      emittedEffectRefs: [ref],
    });
    expect(verifyReplayReceipt(receipt)).toEqual(receipt);
    expect(
      verifyReplayReceiptReferences(receipt, (candidate) =>
        candidate.recordDigest === appended.record.recordDigest
          ? appended.record
          : undefined,
      ),
    ).toEqual(receipt);
    expect(() =>
      verifyReplayReceiptReferences(receipt, () => undefined),
    ).toThrow(HistoryIntegrityError);
    expect(() =>
      verifyReplayReceipt({
        ...receipt,
        emittedEffectRefs: [{ ...ref, recordDigest: '0'.repeat(64) }],
      }),
    ).toThrow(HistoryIntegrityError);
    expect(() =>
      verifyReplayReceipt({ ...receipt, replayKey: 'rewritten-key' }),
    ).toThrow(HistoryIntegrityError);
    expect(() =>
      createReplayReceipt({
        operationId: 'operation-2',
        replayKey: 'replay-2',
        tenantId: identity.tenantId,
        aggregateKind: identity.aggregateKind,
        aggregateId: identity.aggregateId,
        canonicalInputDigest: '2'.repeat(64),
        appliedRevision: 1,
        responseRecordRefs: [null as never],
      }),
    ).toThrow(HistoryIntegrityError);
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it('accepts one exact cursor and rejects a stale expected cursor', () => {
    const genesis = createGenesisHistoryHead(identity);
    const first = appendHistoryRecord({
      head: genesis,
      payload: 'one',
      appliedRevision: 1,
    });
    const second = appendHistoryRecord({
      head: first.head,
      payload: 'two',
      appliedRevision: 2,
    });

    expect(
      verifyHistoryChain([first.record, second.record], second.head),
    ).toEqual(second.head);
    expect(() => verifyHistoryChain([first.record], second.head)).toThrow(
      HistoryIntegrityError,
    );
    expect(() =>
      verifyHistoryChain([second.record, first.record], second.head),
    ).toThrow(HistoryIntegrityError);
  });

  it('replays an exact reference after later records are appended', () => {
    const genesis = createGenesisHistoryHead(identity);
    const first = appendHistoryRecord({
      head: genesis,
      payload: 'first',
      appliedRevision: 1,
    });
    const receipt = createReplayReceipt({
      operationId: 'operation-later',
      replayKey: 'replay-later',
      tenantId: identity.tenantId,
      aggregateKind: identity.aggregateKind,
      aggregateId: identity.aggregateId,
      canonicalInputDigest: canonicalInput('input'),
      appliedRevision: 1,
      responseRecordRefs: [historyRecordReference(first.record)],
    });
    const second = appendHistoryRecord({
      head: first.head,
      payload: 'later',
      appliedRevision: 2,
    });
    expect(
      verifyReplayReceiptReferences(receipt, (reference) =>
        reference.recordDigest === first.record.recordDigest
          ? first.record
          : reference.recordDigest === second.record.recordDigest
            ? second.record
            : undefined,
      ),
    ).toEqual(receipt);
  });

  it('keeps generic receipt snapshots canonical and detached from callers', () => {
    const snapshot = { nested: { value: true } };
    const receipt = createReplayReceipt({
      operationId: 'operation-3',
      replayKey: 'replay-3',
      tenantId: identity.tenantId,
      aggregateKind: identity.aggregateKind,
      aggregateId: identity.aggregateId,
      canonicalInputDigest: '3'.repeat(64),
      appliedRevision: 1,
      responseSnapshot: snapshot,
    });
    expect(
      replayReceiptSchema.safeParse({
        ...receipt,
        responseDigest: receipt.responseDigest,
      }).success,
    ).toBe(true);
    expect(
      replayReceiptSchema.safeParse({
        ...receipt,
        responseSnapshot: new Date(),
      }).success,
    ).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(false);
    expect(snapshot).not.toBe(receipt.responseSnapshot);
    expect(Object.isFrozen(receipt.responseSnapshot)).toBe(true);
    expect(
      Object.isFrozen((receipt.responseSnapshot as { nested: object }).nested),
    ).toBe(true);
    expect(() => {
      (
        receipt.responseSnapshot as { nested: { value: boolean } }
      ).nested.value = false;
    }).toThrow();
    expect(() =>
      createReplayReceipt({
        operationId: 'operation-malformed',
        replayKey: 'replay-malformed',
        tenantId: identity.tenantId,
        aggregateKind: identity.aggregateKind,
        aggregateId: identity.aggregateId,
        canonicalInputDigest: canonicalInput('malformed'),
        appliedRevision: 1,
        responseSnapshot: { nested: new Date() },
      }),
    ).toThrow(HistoryIntegrityError);
  });

  it('binds response and references to identity and detects response or reference tampering', () => {
    const first = appendHistoryRecord({
      head: createGenesisHistoryHead(identity),
      payload: 'response',
      appliedRevision: 1,
    });
    const receipt = createReplayReceipt({
      operationId: 'operation-integrity',
      replayKey: 'replay-integrity',
      tenantId: identity.tenantId,
      aggregateKind: identity.aggregateKind,
      aggregateId: identity.aggregateId,
      canonicalInputDigest: canonicalInput('integrity'),
      appliedRevision: 1,
      responseSnapshot: { ok: true },
    });
    expect(() =>
      verifyReplayReceipt({ ...receipt, responseDigest: '0'.repeat(64) }),
    ).toThrow(HistoryIntegrityError);
    expect(() =>
      verifyReplayReceipt({ ...receipt, tenantId: 'foreign' }),
    ).toThrow(HistoryIntegrityError);
    expect(() =>
      verifyReplayReceiptReferences(
        {
          ...createReplayReceipt({
            operationId: 'operation-ref-integrity',
            replayKey: 'replay-ref-integrity',
            tenantId: identity.tenantId,
            aggregateKind: identity.aggregateKind,
            aggregateId: identity.aggregateId,
            canonicalInputDigest: canonicalInput('ref-integrity'),
            appliedRevision: 1,
            responseRecordRefs: [historyRecordReference(first.record)],
          }),
          responseRecordRefs: [
            {
              ...historyRecordReference(first.record),
              recordDigest: '0'.repeat(64),
            },
          ],
        },
        () => first.record,
      ),
    ).toThrow(HistoryIntegrityError);
    expect(() =>
      verifyReplayReceiptReferences(
        {
          ...createReplayReceipt({
            operationId: 'operation-ref-identity',
            replayKey: 'replay-ref-identity',
            tenantId: identity.tenantId,
            aggregateKind: identity.aggregateKind,
            aggregateId: identity.aggregateId,
            canonicalInputDigest: canonicalInput('ref-identity'),
            appliedRevision: 1,
            responseRecordRefs: [historyRecordReference(first.record)],
          }),
          responseRecordRefs: [
            { ...historyRecordReference(first.record), tenantId: 'foreign' },
          ],
        },
        () => first.record,
      ),
    ).toThrow(HistoryIntegrityError);
  });

  it('keeps Task and Attempt history namespaces separate', () => {
    const taskRecord = createHistoryRecord({
      ...identity,
      sequence: 1,
      previousRecordDigest: null,
      payload: 'same',
      appliedRevision: 1,
    });
    const attemptIdentity = {
      ...identity,
      aggregateKind: 'attempt' as const,
      aggregateId: 'attempt-1',
    };
    const attemptRecord = createHistoryRecord({
      ...attemptIdentity,
      sequence: 1,
      previousRecordDigest: null,
      payload: 'same',
      appliedRevision: 1,
    });
    expect(taskRecord.recordDigest).not.toBe(attemptRecord.recordDigest);
    expect(() =>
      createReplayReceipt({
        operationId: 'operation-cross-kind',
        replayKey: 'replay-cross-kind',
        tenantId: identity.tenantId,
        aggregateKind: identity.aggregateKind,
        aggregateId: identity.aggregateId,
        canonicalInputDigest: canonicalInput('cross-kind'),
        appliedRevision: 1,
        responseRecordRefs: [historyRecordReference(attemptRecord) as never],
      }),
    ).toThrow(HistoryIntegrityError);
  });

  it('rejects strict unknown fields, provider-shaped extras, and malformed references', () => {
    const record = appendHistoryRecord({
      head: createGenesisHistoryHead(identity),
      payload: 'strict',
      appliedRevision: 1,
    }).record;
    const ref = historyRecordReference(record);
    const receipt = createReplayReceipt({
      operationId: 'operation-strict',
      replayKey: 'replay-strict',
      tenantId: identity.tenantId,
      aggregateKind: identity.aggregateKind,
      aggregateId: identity.aggregateId,
      canonicalInputDigest: canonicalInput('strict'),
      appliedRevision: 1,
      responseRecordRefs: [ref],
    });
    expect(
      replayReceiptSchema.safeParse({
        ...receipt,
        providerSecret: 'do-not-persist',
      }).success,
    ).toBe(false);
    expect(
      replayReceiptSchema.safeParse({ ...receipt, unknownField: true }).success,
    ).toBe(false);
    expect(() =>
      verifyReplayReceipt({
        ...receipt,
        responseRecordRefs: [{ ...ref, sequence: 0 }],
      }),
    ).toThrow(HistoryIntegrityError);
    expect(() =>
      verifyReplayReceipt({ ...receipt, responseRecordRefs: [null] }),
    ).toThrow(HistoryIntegrityError);
  });

  it('keeps an idempotency conflict after receipt retention', () => {
    const tombstone = createIdempotencyTombstone({
      tenantId: identity.tenantId,
      aggregateKind: identity.aggregateKind,
      aggregateId: identity.aggregateId,
      replayKey: 'replay-1',
      canonicalInputDigest: '2'.repeat(64),
      receiptPointer: null,
      disposition: 'applied',
    });
    expect(
      assertIdempotencyCompatible(tombstone, {
        tenantId: identity.tenantId,
        aggregateKind: identity.aggregateKind,
        aggregateId: identity.aggregateId,
        replayKey: 'replay-1',
        canonicalInputDigest: '2'.repeat(64),
      }),
    ).toEqual(tombstone);
    expect(() =>
      assertIdempotencyCompatible(tombstone, {
        tenantId: identity.tenantId,
        aggregateKind: identity.aggregateKind,
        aggregateId: identity.aggregateId,
        replayKey: 'replay-1',
        canonicalInputDigest: '3'.repeat(64),
      }),
    ).toThrow(HistoryIntegrityError);
    expect(Object.isFrozen(tombstone)).toBe(true);
    expect(() =>
      assertIdempotencyCompatible(tombstone, {
        tenantId: 'foreign',
        aggregateKind: identity.aggregateKind,
        aggregateId: identity.aggregateId,
        replayKey: 'replay-1',
        canonicalInputDigest: '2'.repeat(64),
      }),
    ).toThrow(HistoryIntegrityError);
    expect(() => verifyReplayReceipt({})).toThrow(HistoryIntegrityError);
  });

  it('enforces one-byte durability boundaries including record and receipt wrappers', () => {
    const canCreateRecord = (length: number): boolean => {
      try {
        createHistoryRecord({
          ...identity,
          sequence: 1,
          previousRecordDigest: null,
          payload: 'x'.repeat(length),
          appliedRevision: 1,
        });
        return true;
      } catch (error) {
        if (error instanceof DurabilityCapacityError) return false;
        throw error;
      }
    };
    let recordLow = 0;
    let recordHigh = LIFECYCLE_DURABILITY_LIMITS.historyRecordBytes;
    while (recordLow + 1 < recordHigh) {
      const middle = Math.floor((recordLow + recordHigh) / 2);
      if (canCreateRecord(middle)) recordLow = middle;
      else recordHigh = middle;
    }
    expect(canCreateRecord(recordLow)).toBe(true);
    expect(canCreateRecord(recordLow + 1)).toBe(false);
    const exactPayload = 'x'.repeat(recordLow);
    const exactRecord = createHistoryRecord({
      ...identity,
      sequence: 1,
      previousRecordDigest: null,
      payload: exactPayload,
      appliedRevision: 1,
    });
    expect(
      serializedDurableByteLength({
        record: exactRecord,
        payload: exactPayload,
      }),
    ).toBe(LIFECYCLE_DURABILITY_LIMITS.historyRecordBytes);
    expect(() =>
      verifyHistoryRecordPayload(exactRecord, `${exactPayload}a`),
    ).toThrow(HistoryIntegrityError);

    const canCreateReceipt = (length: number): boolean => {
      try {
        createReplayReceipt({
          operationId: 'operation-budget',
          replayKey: 'replay-budget',
          tenantId: identity.tenantId,
          aggregateKind: identity.aggregateKind,
          aggregateId: identity.aggregateId,
          canonicalInputDigest: canonicalInput('budget'),
          appliedRevision: 1,
          responseSnapshot: 'x'.repeat(length),
        });
        return true;
      } catch (error) {
        if (error instanceof DurabilityCapacityError) return false;
        throw error;
      }
    };
    let receiptLow = 0;
    let receiptHigh = LIFECYCLE_DURABILITY_LIMITS.replayReceiptBytes;
    while (receiptLow + 1 < receiptHigh) {
      const middle = Math.floor((receiptLow + receiptHigh) / 2);
      if (canCreateReceipt(middle)) receiptLow = middle;
      else receiptHigh = middle;
    }
    expect(canCreateReceipt(receiptLow)).toBe(true);
    expect(canCreateReceipt(receiptLow + 1)).toBe(false);
  });
});

function canonicalInput(input: unknown): string {
  return canonicalReplayInputDigest(input);
}
