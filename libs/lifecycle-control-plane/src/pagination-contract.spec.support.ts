import type {
  PaginationFilter,
  PaginationPage,
  PaginationRequest,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

/** Minimal port consumed by the reusable pagination contract suite. */
export interface BoundedPaginationContractPort<T> {
  page(request: PaginationRequest): Promise<PaginationPage<T>>;
}

export interface BoundedPaginationContractFixture<T> {
  readonly name: string;
  readonly filter: PaginationFilter;
  readonly createPort: () => BoundedPaginationContractPort<T>;
  readonly createEmptyPort: () => BoundedPaginationContractPort<T>;
  readonly alternateFilters: readonly PaginationFilter[];
}

/**
 * Shared async assertions for provider adapters.  The suite intentionally
 * knows only the opaque cursor/page contract; it has no storage or provider
 * imports and can be reused by an in-memory reference or future adapter.
 */
export function boundedPaginationContractSuite<T>(
  fixture: BoundedPaginationContractFixture<T>,
): void {
  describe(`${fixture.name} bounded pagination port contract`, () => {
    it('returns detached first, middle, final, and empty pages', async () => {
      const port = fixture.createPort();
      const first = await port.page({ filter: fixture.filter, limit: 1 });
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.items)).toBe(true);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toEqual(expect.any(String));
      const middle = await port.page({
        filter: fixture.filter,
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      });
      expect(middle.items).not.toEqual(first.items);
      expect(middle.hasMore).toBe(true);
      const final = await port.page({
        filter: fixture.filter,
        limit: 1,
        cursor: middle.nextCursor ?? undefined,
      });
      expect(final.hasMore).toBe(false);
      expect(final.nextCursor).toBeNull();

      const empty = await fixture
        .createEmptyPort()
        .page({ filter: fixture.filter, limit: 1 });
      expect(empty.items).toEqual([]);
      expect(empty.hasMore).toBe(false);
      expect(empty.nextCursor).toBeNull();
    });

    it('does not expose an offset or structural cursor input', async () => {
      const port = fixture.createPort();
      await expect(
        port.page({
          filter: fixture.filter,
          limit: 1,
          cursor: '{"lastKey":"forged"}',
        }),
      ).rejects.toBeDefined();
    });

    it('rejects continuation under every changed closed filter axis', async () => {
      for (const alternateFilter of fixture.alternateFilters) {
        const port = fixture.createPort();
        const first = await port.page({ filter: fixture.filter, limit: 1 });
        await expect(
          port.page({
            filter: alternateFilter,
            limit: 1,
            cursor: first.nextCursor ?? '',
          }),
        ).rejects.toBeDefined();
      }
    });
  });
}
