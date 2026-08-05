import { Container, Skeleton, Stack } from '@mantine/core';

import { ConsoleHeader, type NavKey } from './console-header';

/**
 * Streaming fallback for the console's pages.
 *
 * `cacheComponents` requires every uncached data read to sit inside a
 * `<Suspense>` boundary, so each page renders this while its own data
 * resolves. That is a real improvement on what came before - the pages used
 * to block on the whole GitHub fetch before emitting anything - but it does
 * mean a visible loading state where there previously was none.
 *
 * Deliberately shaped like the page rather than a spinner: the console's
 * rows are uniform, so bars at roughly the right size and count keep the
 * layout from jumping when the real content swaps in.
 *
 * `header` defaults to `true` for the pages that still gate their real
 * title/subtitle behind this same boundary (session detail, login, task -
 * none of those splits an eager shell out the way the five nav-destination
 * pages do). Every nav-destination page passes `header={false}` here for
 * its inner, data-only Suspense - it renders its own `ConsoleHeader` for
 * real above this, and its *outer* boundary uses `NavPageLoading` below
 * instead of this component, so this skeleton block never actually reaches
 * a nav-destination page's screen (#585).
 */
export function PageLoading({
  rows = 5,
  header = true,
}: {
  rows?: number;
  header?: boolean;
}) {
  return (
    <Container size="lg" py="md">
      <Stack gap="md" aria-busy="true" aria-label="Loading">
        {header && (
          // Header block: title + subtitle.
          <Stack gap="xs">
            <Skeleton height={28} width="40%" radius="sm" />
            <Skeleton height={14} width="60%" radius="sm" />
          </Stack>
        )}
        {/* Section heading. */}
        <Skeleton height={20} width="25%" radius="sm" mt="md" />
        {/* Rows. */}
        <Stack gap="sm">
          {Array.from({ length: rows }, (_, i) => (
            <Skeleton key={i} height={64} radius="sm" />
          ))}
        </Stack>
      </Stack>
    </Container>
  );
}

/**
 * Outer-Suspense fallback for the five nav-destination pages (dashboard,
 * inbox, agents, sessions, costs). Each of those pages' own shell only
 * waits on `auth()` + `searchParams` before it can render a real
 * `ConsoleHeader` (see console-header.tsx's doc comment) - neither depends
 * on the slow GitHub/Firestore reads - but `cacheComponents` still forces
 * even that fast a wait behind a Suspense boundary, and the generic
 * `PageLoading` header skeleton has a different shape/height than the real
 * `ConsoleHeader` (title + nav rail + signal bar). Swapping a skeleton bar
 * for that taller, differently-shaped chrome the instant `auth()` resolves
 * is exactly the reflow/ghosting #585 was filed about. None of the header's
 * title or nav rail actually depends on auth or searchParams, so rendering
 * the real `ConsoleHeader` here (behind the same Container the resolved
 * page uses, with a placeholder subtitle) keeps the eventual swap limited
 * to the subtitle text and command-row utilities - the header's own shape
 * and the page's own Container never change.
 */
export function NavPageLoading({
  current,
  title,
  className,
  rows = 5,
}: {
  current: NavKey;
  title: string;
  className: string;
  rows?: number;
}) {
  return (
    <Container size="xl" py="xl" className={className}>
      <ConsoleHeader current={current} title={title} subtitle="…" />
      <PageLoading rows={rows} header={false} />
    </Container>
  );
}
