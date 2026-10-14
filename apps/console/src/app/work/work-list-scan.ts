/**
 * The Work API filters each store page after reading it (issue #1546), so
 * one filtered page can come back empty while older matches sit behind its
 * cursor. With a filter active the Work page keeps reading forward until it
 * has a screenful, reaches the end, or spends its page budget, then hands
 * the reader the cursor where it stopped.
 */
export const WORK_SCAN_FILL = 50;
export const WORK_SCAN_MAX_PAGES = 5;

export interface WorkScanPage<T> {
  items: T[];
  nextCursor?: string;
}

export type WorkScanList<T, E> = (
  cursor: string | undefined,
) => Promise<{ error: E } | { page: WorkScanPage<T> }>;

export type WorkScanResult<T, E> =
  | { error: E }
  | {
      items: T[];
      /** Store pages read for this view. */
      pages: number;
      /** Where the next view resumes; absent once every task was read. */
      nextCursor?: string;
      /** A later page failed; `nextCursor` retries it. */
      stoppedOn?: E;
    };

export async function scanWorkPages<T, E>({
  list,
  cursor,
  matches,
  scan,
}: {
  list: WorkScanList<T, E>;
  cursor: string | undefined;
  matches: (item: T) => boolean;
  /** False reads exactly one page: nothing is filtered away. */
  scan: boolean;
}): Promise<WorkScanResult<T, E>> {
  const items: T[] = [];
  let pages = 0;
  let next = cursor;
  do {
    const result = await list(next);
    if ('error' in result) {
      return pages === 0
        ? { error: result.error }
        : { items, pages, nextCursor: next, stoppedOn: result.error };
    }
    pages += 1;
    items.push(...result.page.items.filter(matches));
    next = result.page.nextCursor;
  } while (
    scan &&
    next !== undefined &&
    items.length < WORK_SCAN_FILL &&
    pages < WORK_SCAN_MAX_PAGES
  );
  return { items, pages, ...(next === undefined ? {} : { nextCursor: next }) };
}
