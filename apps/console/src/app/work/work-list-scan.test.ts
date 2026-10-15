import { describe, expect, it, vi } from 'vitest';

import {
  scanWorkPages,
  WORK_SCAN_FILL,
  WORK_SCAN_MAX_PAGES,
  type WorkScanList,
} from './work-list-scan';

/** Store pages of numbers; page N's cursor is `cN`. */
function pagesOf(pages: number[][], failAt?: number) {
  const list = vi.fn<WorkScanList<number, string>>(async (cursor) => {
    const index = cursor === undefined ? 0 : Number(cursor.slice(1));
    if (index === failAt) return { error: 'boom' };
    return {
      page: {
        items: pages[index] ?? [],
        ...(index + 1 < pages.length ? { nextCursor: `c${index + 1}` } : {}),
      },
    };
  });
  return list;
}

const even = (n: number) => n % 2 === 0;

describe('scanWorkPages', () => {
  it('reads one page when nothing is filtered', async () => {
    const list = pagesOf([
      [1, 2],
      [3, 4],
    ]);
    const result = await scanWorkPages({
      list,
      cursor: undefined,
      matches: () => true,
      scan: false,
    });
    expect(result).toEqual({ items: [1, 2], pages: 1, nextCursor: 'c1' });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('reads past empty filtered pages to the older matches', async () => {
    const list = pagesOf([
      [1, 3],
      [5, 7],
      [8, 9],
    ]);
    const result = await scanWorkPages({
      list,
      cursor: undefined,
      matches: even,
      scan: true,
    });
    // The last page was read, so there is no cursor left to offer.
    expect(result).toEqual({ items: [8], pages: 3 });
  });

  it('stops once it has a screenful and resumes from there', async () => {
    const full = Array.from({ length: WORK_SCAN_FILL }, (_, i) => i * 2);
    const list = pagesOf([full, [100]]);
    const result = await scanWorkPages({
      list,
      cursor: undefined,
      matches: even,
      scan: true,
    });
    expect(result).toEqual({ items: full, pages: 1, nextCursor: 'c1' });
  });

  it('spends at most its page budget', async () => {
    const list = pagesOf(Array.from({ length: 10 }, () => [1]));
    const result = await scanWorkPages({
      list,
      cursor: 'c2',
      matches: even,
      scan: true,
    });
    expect(result).toEqual({
      items: [],
      pages: WORK_SCAN_MAX_PAGES,
      nextCursor: `c${2 + WORK_SCAN_MAX_PAGES}`,
    });
  });

  it('reports a first-page failure as the error', async () => {
    const result = await scanWorkPages({
      list: pagesOf([[2]], 0),
      cursor: undefined,
      matches: even,
      scan: true,
    });
    expect(result).toEqual({ error: 'boom' });
  });

  it('keeps what it found when a later page fails, resuming at that page', async () => {
    const result = await scanWorkPages({
      list: pagesOf([[2], [3], [4]], 1),
      cursor: undefined,
      matches: even,
      scan: true,
    });
    expect(result).toEqual({
      items: [2],
      pages: 1,
      nextCursor: 'c1',
      stoppedOn: 'boom',
    });
  });
});
