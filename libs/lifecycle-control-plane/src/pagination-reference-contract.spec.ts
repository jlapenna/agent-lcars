import {
  type PaginationFilter,
  ReferencePaginator,
} from '@agent-lcars/dispatch-contracts';

import { boundedPaginationContractSuite } from './pagination-contract.spec.support';

type Item = { id: string; value: string };

function createOpaqueCodec() {
  const payloads = new Map<string, unknown>();
  let next = 0;
  return {
    mint(payload: unknown): unknown {
      const cursor = `opaque-reference-cursor-${next++}`;
      payloads.set(cursor, structuredClone(payload));
      return cursor;
    },
    verify(cursor: string): unknown {
      const payload = payloads.get(cursor);
      if (payload === undefined) throw new Error('forged cursor');
      return structuredClone(payload);
    },
  };
}

const filters = [
  {
    tenantId: 'tenant-a',
    collection: 'task-presentations' as const,
    subject: { kind: 'task' as const, repositoryId: 1, issueNumber: 2 },
    state: 'pending' as const,
  },
  {
    tenantId: 'tenant-a',
    collection: 'attempt-presentations' as const,
    subject: { kind: 'attempt' as const, attemptId: 'attempt-1' },
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
    subject: { kind: 'task' as const, repositoryId: 1, issueNumber: 2 },
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
] satisfies readonly PaginationFilter[];

function alternateFilters(
  filter: PaginationFilter,
): readonly PaginationFilter[] {
  const tenant = { ...filter, tenantId: 'tenant-b' } as PaginationFilter;
  if (filter.collection === 'presentation-delivery') {
    return [tenant, { ...filter, source: 'task' }];
  }
  if (filter.collection === 'task-presentations') {
    return [tenant, { ...filter, state: 'obsolete' }];
  }
  if (filter.collection === 'task-effects') {
    return [tenant, { ...filter, state: 'complete' }];
  }
  if (filter.collection === 'cancellation-work') {
    return [tenant, { ...filter, state: 'awaiting-binding' }];
  }
  if (filter.collection === 'validation-work') {
    return [tenant, { ...filter, state: 'complete' }];
  }
  if (filter.collection === 'launch-work') {
    return [tenant, { ...filter, state: 'accepted' }];
  }
  return [tenant];
}

function createPort(filter: PaginationFilter, records: readonly Item[]) {
  return new ReferencePaginator<Item>({
    collection: filter.collection,
    codec: createOpaqueCodec(),
    records: () => records,
    matches: () => true,
    keyOf: (item) => ({ key: item.value, tieBreaker: item.id }),
    now: () => '2026-08-15T00:00:00.000Z',
  });
}

for (const filter of filters) {
  boundedPaginationContractSuite({
    name: filter.collection,
    filter,
    alternateFilters: alternateFilters(filter),
    createPort: () =>
      createPort(filter, [
        { id: 'a', value: 'A' },
        { id: 'b', value: 'B' },
        { id: 'c', value: 'C' },
      ]),
    createEmptyPort: () => createPort(filter, []),
  });
}
