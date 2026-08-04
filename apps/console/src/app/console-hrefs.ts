/**
 * Plain shared module - no 'use client', no server-only imports - so both
 * sides can import it. console-header.tsx is a client module, and a
 * function exported from a client module cannot be *called* by server
 * components (only rendered), which is exactly what action-items-board
 * and the page shells need to do with this helper.
 */
export function repoScopedConsoleHrefs(repoFilter?: string):
  | {
      deck: string;
      inbox: string;
    }
  | undefined {
  if (!repoFilter) return undefined;
  const query = new URLSearchParams({ repo: repoFilter }).toString();
  return { deck: `/?${query}`, inbox: `/inbox?${query}` };
}
