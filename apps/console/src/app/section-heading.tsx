import { Text, Title } from '@mantine/core';

/** Shared two-line heading (title + "N items · description") for every
 * board tier, including tiers rendered from a client component (e.g.
 * your-queue-section.tsx) - it has no server-only dependencies, so it's
 * safe from either side. */
export function SectionHeading({
  title,
  count,
  description,
  primary = false,
}: {
  title: string;
  count: number;
  description: string;
  primary?: boolean;
}) {
  return (
    <>
      <Title order={primary ? 2 : 3} size={primary ? undefined : 'h4'} mb={2}>
        {title}
      </Title>
      <Text c="dimmed" size="sm" mb="sm">
        {count} {count === 1 ? 'item' : 'items'} · {description}
      </Text>
    </>
  );
}
