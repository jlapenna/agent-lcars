import { Container, Skeleton, Stack } from '@mantine/core';

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
 * title/subtitle behind this same boundary (session detail, login - neither
 * splits an eager shell out the way the three nav destinations do). Every
 * nav-destination page (dashboard, agents, sessions - see
 * console-header.tsx's doc comment) instead renders its `ConsoleHeader`
 * eagerly in an outer shell and passes `header={false}` here for its inner,
 * data-only Suspense, so that placeholder doesn't duplicate a title/subtitle
 * skeleton underneath the real one.
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
