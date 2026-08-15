import { describe, expect, it } from 'vitest';

import {
  LIFECYCLE_DURABILITY_LIMITS,
  serializedDurableByteLength,
} from './durability';
import type { CurrentPointerReader } from './pagination';
import {
  createCurrentPointer,
  PAGINATION_ORDER_VERSIONS,
  PaginationCapacityError,
  PaginationCursorError,
  paginationFilterSchema,
  paginationPageSchema,
  paginationSubjectSchema,
  ReferencePaginator,
  validateCurrentPointer,
} from './pagination';

type Item = { id: string; value: string };
const paginationAttemptId = `_${'A'.repeat(21)}`;

it('accepts a minted AttemptId with a leading underscore as a pagination subject', () => {
  expect(
    paginationSubjectSchema.safeParse({
      kind: 'attempt',
      attemptId: `_${'A'.repeat(21)}`,
    }).success,
  ).toBe(true);
});

function codec() {
  const payloads = new Map<string, unknown>();
  let next = 0;
  return {
    mint(payload: unknown) {
      const cursor = `opaque-cursor-${next++}`;
      payloads.set(cursor, structuredClone(payload));
      return cursor;
    },
    verify(cursor: string) {
      const payload = payloads.get(cursor);
      if (payload === undefined) throw new Error('forged cursor');
      return structuredClone(payload);
    },
  };
}

const filter = {
  tenantId: 'tenant-a',
  collection: 'task-presentations' as const,
  subject: { kind: 'task' as const, repositoryId: 1, issueNumber: 2 },
};

describe('bounded keyset pagination', () => {
  it('returns first, middle, and final pages with deterministic continuation', async () => {
    const values: Item[] = [
      { id: 'a', value: 'A' },
      { id: 'b', value: 'B' },
      { id: 'c', value: 'C' },
    ];
    const paginator = new ReferencePaginator<Item>({
      collection: filter.collection,
      codec: codec(),
      records: () => values,
      matches: () => true,
      keyOf: (item) => ({ key: item.value, tieBreaker: item.id }),
      now: () => '2026-08-15T00:00:00.000Z',
    });
    const first = await paginator.page({ filter, limit: 1 });
    const middle = await paginator.page({
      filter,
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    const final = await paginator.page({
      filter,
      limit: 1,
      cursor: middle.nextCursor ?? undefined,
    });
    expect(first.items.map((item) => item.id)).toEqual(['a']);
    expect(middle.items.map((item) => item.id)).toEqual(['b']);
    expect(final.items.map((item) => item.id)).toEqual(['c']);
    expect(final.hasMore).toBe(false);
    expect(final.nextCursor).toBeNull();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.items)).toBe(true);
  });

  it('keeps a stable snapshot while allowing concurrent append', async () => {
    const values: Item[] = [
      { id: 'a', value: 'A' },
      { id: 'b', value: 'B' },
    ];
    const paginator = new ReferencePaginator<Item>({
      collection: filter.collection,
      codec: codec(),
      records: () => values,
      matches: () => true,
      keyOf: (item) => ({ key: item.value, tieBreaker: item.id }),
      now: () => '2026-08-15T00:00:00.000Z',
    });
    const first = await paginator.page({ filter, limit: 1 });
    values.push({ id: 'c', value: 'C' });
    const second = await paginator.page({
      filter,
      limit: 10,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((item) => item.id)).toEqual(['b']);
  });

  it('rejects altered scope, malformed/expired cursors, and over-limit requests', async () => {
    let now = '2026-08-15T00:00:00.000Z';
    const paginator = new ReferencePaginator<Item>({
      collection: filter.collection,
      codec: codec(),
      records: () => [
        { id: 'a', value: 'A' },
        { id: 'b', value: 'B' },
      ],
      matches: () => true,
      keyOf: (item) => ({ key: item.value, tieBreaker: item.id }),
      now: () => now,
      cursorTtlMs: 1_000,
    });
    const page = await paginator.page({ filter, limit: 1 });
    await expect(
      paginator.page({
        filter: { ...filter, tenantId: 'tenant-b' },
        limit: 1,
        cursor: page.nextCursor ?? undefined,
      }),
    ).rejects.toThrow(PaginationCursorError);
    await expect(paginator.page({ filter, limit: 101 })).rejects.toThrow(
      PaginationCapacityError,
    );
    now = '2026-08-15T00:01:00.000Z';
    await expect(
      paginator.page({ filter, limit: 1, cursor: page.nextCursor ?? 'bad' }),
    ).rejects.toThrow(PaginationCursorError);
  });

  it('validates opaque codec outputs and rejects malformed, oversized, and unsupported cursors', async () => {
    let minted: unknown;
    const paginator = new ReferencePaginator<Item>({
      collection: filter.collection,
      codec: {
        mint: (payload) => {
          minted = structuredClone(payload);
          return 'opaque-codec-output';
        },
        verify: (cursor) => {
          if (cursor === 'unsupported') {
            return { ...(minted as Record<string, unknown>), version: 2 };
          }
          if (cursor === 'malformed') return { lastKey: 'only-one-field' };
          return structuredClone(minted);
        },
      },
      records: () => [
        { id: 'a', value: 'A' },
        { id: 'b', value: 'B' },
      ],
      matches: () => true,
      keyOf: (item) => ({ key: item.value, tieBreaker: item.id }),
      now: () => '2026-08-15T00:00:00.000Z',
    });
    await paginator.page({ filter, limit: 1 });
    await expect(
      paginator.page({ filter, limit: 1, cursor: 'malformed' }),
    ).rejects.toMatchObject({ reason: 'malformed' });
    await expect(
      paginator.page({ filter, limit: 1, cursor: 'unsupported' }),
    ).rejects.toMatchObject({ reason: 'unsupported-version' });
    await expect(
      paginator.page({ filter, limit: 1, cursor: 'x'.repeat(4097) }),
    ).rejects.toMatchObject({ reason: 'malformed' });
  });

  it('bounds snapshot retention without evicting a live continuation', async () => {
    let value = 'A';
    let now = '2026-08-15T00:00:00.000Z';
    const paginator = new ReferencePaginator<Item>({
      collection: filter.collection,
      codec: codec(),
      records: () => [
        { id: 'a', value },
        { id: 'b', value: `${value}-next` },
      ],
      matches: () => true,
      keyOf: (item) => ({ key: item.value, tieBreaker: item.id }),
      now: () => now,
      cursorTtlMs: 1_000,
    });
    const first = await paginator.page({ filter, limit: 1 });
    for (let issueNumber = 3; issueNumber <= 33; issueNumber += 1) {
      value = `value-${issueNumber}`;
      await paginator.page({
        filter: {
          ...filter,
          subject: { ...filter.subject, issueNumber },
        },
        limit: 1,
      });
    }
    value = 'over-capacity';
    await expect(
      paginator.page({
        filter: {
          ...filter,
          subject: { ...filter.subject, issueNumber: 34 },
        },
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(PaginationCapacityError);
    value = 'A';
    await expect(
      paginator.page({ filter, limit: 1, cursor: first.nextCursor ?? '' }),
    ).resolves.toMatchObject({ items: [{ id: 'b' }] });
    now = '2026-08-15T00:01:00.000Z';
    await expect(
      paginator.page({
        filter: {
          ...filter,
          subject: { ...filter.subject, issueNumber: 34 },
        },
        limit: 1,
      }),
    ).resolves.toMatchObject({ hasMore: true });
  });

  it('purges an exactly expired snapshot before enforcing retention capacity', async () => {
    let now = '2026-08-15T00:00:00.000Z';
    const paginator = new ReferencePaginator<Item>({
      collection: filter.collection,
      codec: codec(),
      records: () => [
        { id: 'a', value: 'A' },
        { id: 'b', value: 'B' },
      ],
      matches: () => true,
      keyOf: (item) => ({ key: item.value, tieBreaker: item.id }),
      now: () => now,
      cursorTtlMs: 1_000,
    });

    await paginator.page({ filter, limit: 1 });
    now = '2026-08-15T00:00:01.000Z';
    for (let issueNumber = 3; issueNumber <= 34; issueNumber += 1) {
      await expect(
        paginator.page({
          filter: {
            ...filter,
            subject: { ...filter.subject, issueNumber },
          },
          limit: 1,
        }),
      ).resolves.toMatchObject({ hasMore: true });
    }
  });

  it('orders equal keys by immutable tie-breaker and supports empty pages', async () => {
    const paginator = new ReferencePaginator<Item>({
      collection: filter.collection,
      codec: codec(),
      records: () => [
        { id: 'b', value: 'same' },
        { id: 'a', value: 'same' },
      ],
      matches: () => true,
      keyOf: (item) => ({ key: item.value, tieBreaker: item.id }),
      now: () => '2026-08-15T00:00:00.000Z',
    });
    const page = await paginator.page({ filter, limit: 10 });
    expect(page.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(PAGINATION_ORDER_VERSIONS[filter.collection]).toBe(
      'task-presentations/v1',
    );
    const empty = await new ReferencePaginator<Item>({
      collection: filter.collection,
      codec: codec(),
      records: () => [],
      matches: () => true,
      keyOf: (item) => ({ key: item.value, tieBreaker: item.id }),
      now: () => '2026-08-15T00:00:00.000Z',
    }).page({ filter, limit: 1 });
    expect(empty.items).toEqual([]);
    expect(empty.hasMore).toBe(false);
    expect(empty.nextCursor).toBeNull();
  });

  it('rejects duplicate immutable key/tie-breaker tuples', async () => {
    const paginator = new ReferencePaginator<Item>({
      collection: filter.collection,
      codec: codec(),
      records: () => [
        { id: 'same', value: 'same' },
        { id: 'same', value: 'same' },
      ],
      matches: () => true,
      keyOf: (item) => ({ key: item.value, tieBreaker: item.id }),
      now: () => '2026-08-15T00:00:00.000Z',
    });
    await expect(paginator.page({ filter, limit: 10 })).rejects.toThrow(
      PaginationCursorError,
    );
  });

  it('rejects a codec that emits malformed opaque output', async () => {
    const paginator = new ReferencePaginator<Item>({
      collection: filter.collection,
      codec: {
        mint: () => '',
        verify: () => {
          throw new Error('not used');
        },
      },
      records: () => [
        { id: 'a', value: 'A' },
        { id: 'b', value: 'B' },
      ],
      matches: () => true,
      keyOf: (item) => ({ key: item.value, tieBreaker: item.id }),
      now: () => '2026-08-15T00:00:00.000Z',
    });
    await expect(paginator.page({ filter, limit: 1 })).rejects.toThrow(
      PaginationCursorError,
    );
  });

  it('rejects a same-scope cursor with a boundary absent from the snapshot', async () => {
    let minted: unknown;
    const paginator = new ReferencePaginator<Item>({
      collection: filter.collection,
      codec: {
        mint: (payload) => {
          minted = structuredClone(payload);
          return 'opaque-forged-boundary';
        },
        verify: () => ({
          ...(minted as Record<string, unknown>),
          lastKey: 'forged-key',
          lastTieBreaker: 'forged-tie',
        }),
      },
      records: () => [
        { id: 'a', value: 'A' },
        { id: 'b', value: 'B' },
      ],
      matches: () => true,
      keyOf: (item) => ({ key: item.value, tieBreaker: item.id }),
      now: () => '2026-08-15T00:00:00.000Z',
    });
    const first = await paginator.page({ filter, limit: 1 });
    await expect(
      paginator.page({ filter, limit: 1, cursor: first.nextCursor ?? '' }),
    ).rejects.toMatchObject({ reason: 'scope-mismatch' });
  });

  it('rejects cursor collection, order, subject, and snapshot substitutions', async () => {
    const substitutions: Array<(payload: Record<string, unknown>) => void> = [
      (payload) => {
        payload.collection = 'attempt-presentations';
      },
      (payload) => {
        payload.orderVersion = 'attempt-presentations/v1';
      },
      (payload) => {
        payload.subject = {
          kind: 'task',
          repositoryId: 3,
          issueNumber: 4,
        };
      },
      (payload) => {
        payload.snapshot = {
          ...(payload.snapshot as Record<string, unknown>),
          count: 99,
        };
      },
    ];
    for (const substitute of substitutions) {
      let minted: unknown;
      const paginator = new ReferencePaginator<Item>({
        collection: filter.collection,
        codec: {
          mint: (payload) => {
            minted = structuredClone(payload);
            return 'opaque-substitution';
          },
          verify: () => {
            const forged = structuredClone(minted) as Record<string, unknown>;
            substitute(forged);
            return forged;
          },
        },
        records: () => [
          { id: 'a', value: 'A' },
          { id: 'b', value: 'B' },
        ],
        matches: () => true,
        keyOf: (item) => ({ key: item.value, tieBreaker: item.id }),
        now: () => '2026-08-15T00:00:00.000Z',
      });
      const first = await paginator.page({ filter, limit: 1 });
      await expect(
        paginator.page({
          filter,
          limit: 1,
          cursor: first.nextCursor ?? '',
        }),
      ).rejects.toThrow(PaginationCursorError);
    }
  });

  it('maps date arithmetic overflow to a typed cursor error', async () => {
    const paginator = new ReferencePaginator<Item>({
      collection: filter.collection,
      codec: codec(),
      records: () => [{ id: 'a', value: 'A' }],
      matches: () => true,
      keyOf: (item) => ({ key: item.value, tieBreaker: item.id }),
      now: () => new Date(8_640_000_000_000_000).toISOString(),
      cursorTtlMs: 1,
    });
    await expect(paginator.page({ filter, limit: 1 })).rejects.toMatchObject({
      reason: 'malformed',
    });
  });

  it('validates direct current pointers independently from listing', () => {
    const pointer = createCurrentPointer({
      tenantId: 'tenant-a',
      kind: 'task',
      subject: filter.subject,
      taskKey: 'task-current',
      revision: 4,
    });
    expect(pointer.taskKey).toBe('task-current');
    expect(Object.isFrozen(pointer)).toBe(true);
    expect(() =>
      validateCurrentPointer({ ...pointer, taskKey: 'other-task' }),
    ).toThrow();
    expect(() => validateCurrentPointer({ ...pointer, revision: 5 })).toThrow();
  });

  it('keeps every current-pointer namespace closed and directly addressable', () => {
    const pointers = [
      {
        kind: 'task' as const,
        subject: filter.subject,
        taskKey: 'task-current',
      },
      {
        kind: 'attempt' as const,
        subject: { kind: 'attempt' as const, attemptId: paginationAttemptId },
        attemptKey: 'attempt-current',
      },
      {
        kind: 'task-presentation' as const,
        subject: filter.subject,
        operationId: 'operation-1',
      },
      {
        kind: 'attempt-presentation' as const,
        subject: { kind: 'attempt' as const, attemptId: paginationAttemptId },
        operationId: 'operation-1',
      },
      {
        kind: 'delivery' as const,
        source: 'task' as const,
        subject: filter.subject,
        operationId: 'operation-1',
      },
      {
        kind: 'delivery' as const,
        source: 'attempt' as const,
        subject: filter.subject,
        attemptId: paginationAttemptId,
        operationId: 'operation-1',
      },
      {
        kind: 'task-effect' as const,
        subject: filter.subject,
        sourceFactId: 'fact-1',
        effectKey: 'effect-1',
      },
      {
        kind: 'cancellation-work' as const,
        subject: { kind: 'attempt' as const, attemptId: paginationAttemptId },
        eventId: 'event-1',
      },
      {
        kind: 'validation-work' as const,
        subject: { kind: 'attempt' as const, attemptId: paginationAttemptId },
        terminalFactId: 'terminal-1',
        claimFactId: 'claim-1',
      },
      {
        kind: 'launch-work' as const,
        subject: { kind: 'attempt' as const, attemptId: paginationAttemptId },
        operationId: paginationAttemptId,
      },
    ];
    for (const pointer of pointers) {
      const created = createCurrentPointer({
        ...pointer,
        tenantId: 'tenant-a',
        revision: 1,
      });
      expect(validateCurrentPointer(created).kind).toBe(pointer.kind);
    }
  });

  it('keeps the page schema closed', () => {
    expect(
      paginationPageSchema.safeParse({
        schema: 'agent-lcars.lifecycle-pagination-page/v1',
        version: 1,
        tenantId: 'tenant-a',
        collection: filter.collection,
        snapshot: { count: 0, headDigest: 'b'.repeat(64) },
        items: [new Date()],
        hasMore: false,
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it('accepts each closed collection filter variant', () => {
    const filters = [
      filter,
      {
        tenantId: 'tenant-a',
        collection: 'attempt-presentations' as const,
        subject: { kind: 'attempt' as const, attemptId: paginationAttemptId },
      },
      {
        tenantId: 'tenant-a',
        collection: 'presentation-delivery' as const,
        subject: { kind: 'tenant' as const },
        source: 'attempt' as const,
        state: 'pending' as const,
      },
      {
        tenantId: 'tenant-a',
        collection: 'task-effects' as const,
        subject: filter.subject,
        state: 'working' as const,
      },
      {
        tenantId: 'tenant-a',
        collection: 'cancellation-work' as const,
        subject: { kind: 'tenant' as const },
        state: 'pending' as const,
      },
      {
        tenantId: 'tenant-a',
        collection: 'validation-work' as const,
        subject: { kind: 'tenant' as const },
        state: 'resolving' as const,
      },
      {
        tenantId: 'tenant-a',
        collection: 'launch-work' as const,
        subject: { kind: 'tenant' as const },
        state: 'dispatching' as const,
      },
    ];
    for (const candidate of filters) {
      expect(paginationFilterSchema.safeParse(candidate).success).toBe(true);
    }
    expect(
      paginationFilterSchema.safeParse({
        ...filter,
        collection: 'task-presentations',
        source: 'attempt',
      }).success,
    ).toBe(false);
    expect(
      paginationFilterSchema.safeParse({
        tenantId: 'tenant-a',
        collection: 'presentation-delivery',
        subject: { kind: 'tenant' },
        source: 'provider',
      }).success,
    ).toBe(false);
    expect(
      paginationFilterSchema.safeParse({
        ...filter,
        subject: { kind: 'tenant' },
      }).success,
    ).toBe(false);
  });

  it('rejects a single item that exceeds the page byte budget and detaches nested values', async () => {
    const nested = { state: { label: 'original' } };
    const source = [{ id: 'a', value: 'A', nested }];
    const paginator = new ReferencePaginator<{
      id: string;
      value: string;
      nested: { state: { label: string } };
    }>({
      collection: filter.collection,
      codec: codec(),
      records: () => source,
      matches: () => true,
      keyOf: (item) => ({ key: item.value, tieBreaker: item.id }),
      now: () => '2026-08-15T00:00:00.000Z',
    });
    const page = await paginator.page({ filter, limit: 1 });
    expect(page.items[0]).not.toBe(source[0]);
    expect(Object.isFrozen(page.items[0])).toBe(true);
    expect(Object.isFrozen(page.items[0].nested)).toBe(true);
    source[0].nested.state.label = 'changed';
    expect(page.items[0].nested.state.label).toBe('original');

    const oversized = new ReferencePaginator<Item>({
      collection: filter.collection,
      codec: codec(),
      records: () => [{ id: 'a', value: 'x'.repeat(270_000) }],
      matches: () => true,
      keyOf: () => ({ key: 'A', tieBreaker: 'a' }),
      now: () => '2026-08-15T00:00:00.000Z',
    });
    await expect(oversized.page({ filter, limit: 1 })).rejects.toMatchObject({
      unit: 'bytes',
    });
  });

  it('enforces exact item and UTF-8 page boundaries without truncating', async () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      id: `item-${index}`,
      value: `${index}`,
    }));
    const itemPaginator = new ReferencePaginator<Item>({
      collection: filter.collection,
      codec: codec(),
      records: () => items,
      matches: () => true,
      keyOf: (item) => ({ key: item.value, tieBreaker: item.id }),
      now: () => '2026-08-15T00:00:00.000Z',
    });
    await expect(
      itemPaginator.page({
        filter,
        limit: LIFECYCLE_DURABILITY_LIMITS.pageItemCount,
      }),
    ).resolves.toMatchObject({ items: expect.any(Array), hasMore: false });
    await expect(
      itemPaginator.page({
        filter,
        limit: LIFECYCLE_DURABILITY_LIMITS.pageItemCount + 1,
      }),
    ).rejects.toMatchObject({
      unit: 'items',
      maximum: LIFECYCLE_DURABILITY_LIMITS.pageItemCount,
    });

    const canReturnUtf8Count = async (count: number): Promise<boolean> => {
      const paginator = new ReferencePaginator<Item>({
        collection: filter.collection,
        codec: codec(),
        records: () => [{ id: 'utf8', value: '🙂'.repeat(count) }],
        matches: () => true,
        keyOf: (item) => ({ key: item.id, tieBreaker: item.id }),
        now: () => '2026-08-15T00:00:00.000Z',
      });
      try {
        const page = await paginator.page({ filter, limit: 1 });
        return (
          serializedDurableByteLength(page) <=
          LIFECYCLE_DURABILITY_LIMITS.pageBytes
        );
      } catch (error) {
        if (error instanceof PaginationCapacityError) return false;
        throw error;
      }
    };
    let accepted = 0;
    let rejected = 70_000;
    while (accepted + 1 < rejected) {
      const candidate = Math.floor((accepted + rejected) / 2);
      if (await canReturnUtf8Count(candidate)) accepted = candidate;
      else rejected = candidate;
    }
    expect(await canReturnUtf8Count(accepted)).toBe(true);
    expect(await canReturnUtf8Count(rejected)).toBe(false);
  });

  it('uses direct current-pointer lookup without a history or page scan', async () => {
    const reads: unknown[] = [];
    const reader: CurrentPointerReader<{ readonly revision: number }> = {
      readCurrent: async (input) => {
        reads.push(input);
        return { revision: 9 };
      },
    };
    await expect(
      reader.readCurrent({
        tenantId: 'tenant-a',
        kind: 'task',
        subject: filter.subject,
        taskKey: 'task-current',
      }),
    ).resolves.toEqual({ revision: 9 });
    expect(reads).toEqual([
      {
        tenantId: 'tenant-a',
        kind: 'task',
        subject: filter.subject,
        taskKey: 'task-current',
      },
    ]);
  });
});
