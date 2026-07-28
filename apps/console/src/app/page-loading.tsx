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
 */
export function PageLoading({ rows = 5 }: { rows?: number }) {
  return (
    <Container size="lg" py="md">
      <Stack gap="md" aria-busy="true" aria-label="Loading">
        {/* Header block: title + subtitle. */}
        <Stack gap="xs">
          <Skeleton height={28} width="40%" radius="sm" />
          <Skeleton height={14} width="60%" radius="sm" />
        </Stack>
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
