import type { ItemState, ItemView } from '@agent-lcars/work/derive';
import {
  Anchor,
  Badge,
  Group,
  Stack,
  Table,
  TableScrollContainer,
  TableTbody,
  TableTd,
  TableTh,
  TableThead,
  TableTr,
  Text,
} from '@mantine/core';

import { formatRelativeTime } from '../format';

/** parked < running < done < canceled - a parked item is the one most
 *  likely to need attention (it settled without success and nobody has
 *  redispatched it yet), so it sorts to the top. */
const STATE_ORDER: Record<ItemState, number> = {
  parked: 0,
  running: 1,
  done: 2,
  canceled: 3,
};

/** Same palette as the detail page's `STATE_COLORS` (`[id]/page.tsx`). */
const STATE_COLORS: Record<ItemState, string> = {
  parked: 'yellow',
  running: 'blue',
  done: 'green',
  canceled: 'gray',
};

/** One work item, laid out for a phone rather than truncated into a
 *  6-column table row (same "cards below `sm`" split the sessions archive
 *  uses - `session-table.tsx`). */
function WorkCard({ item }: { item: ItemView }) {
  return (
    <article className="work-mobile-row" data-testid={`work-card-${item.id}`}>
      <Stack gap={6}>
        <Group justify="space-between" align="center" wrap="wrap" gap={6}>
          <Anchor href={`/work/${item.id}`} size="sm" fw={500}>
            {item.spec.title}
          </Anchor>
          <Badge variant="light" size="xs" color={STATE_COLORS[item.state]}>
            {item.state}
          </Badge>
        </Group>
        <Text size="xs" c="dimmed">
          {item.spec.target.repo} &middot; {item.spec.pipeline}
        </Text>
        <Text size="xs" c="dimmed">
          {item.origin.principal} · updated {formatRelativeTime(item.updatedAt)}
        </Text>
      </Stack>
    </article>
  );
}

/**
 * The `/work` list table: server-safe (no hooks), so the page can render it
 * directly from the server-fetched `listItems` result. Below `sm`, the
 * 6-column table is replaced by one card per item (`WorkCard` above); both
 * branches render unconditionally via Mantine's visibleFrom/hiddenFrom CSS
 * media queries, not JS.
 */
export function WorkList({ items }: { items: ItemView[] }) {
  if (items.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No work items yet.
      </Text>
    );
  }

  const sorted = [...items].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state],
  );

  return (
    <>
      <Stack gap={0} hiddenFrom="sm" data-testid="work-cards">
        {sorted.map((item) => (
          <WorkCard key={item.id} item={item} />
        ))}
      </Stack>

      <TableScrollContainer
        minWidth={640}
        visibleFrom="sm"
        className="work-table-scroll"
      >
        <Table
          striped
          highlightOnHover
          verticalSpacing="xs"
          fz="sm"
          className="work-table"
        >
          <TableThead>
            <TableTr>
              <TableTh>Title</TableTh>
              <TableTh>State</TableTh>
              <TableTh>Pipeline</TableTh>
              <TableTh>Repo</TableTh>
              <TableTh>Principal</TableTh>
              <TableTh>Updated</TableTh>
            </TableTr>
          </TableThead>
          <TableTbody>
            {sorted.map((item) => (
              <TableTr key={item.id}>
                <TableTd>
                  <Anchor href={`/work/${item.id}`} size="sm">
                    {item.spec.title}
                  </Anchor>
                </TableTd>
                <TableTd>{item.state}</TableTd>
                <TableTd>{item.spec.pipeline}</TableTd>
                <TableTd>{item.spec.target.repo}</TableTd>
                <TableTd>{item.origin.principal}</TableTd>
                <TableTd>{formatRelativeTime(item.updatedAt)}</TableTd>
              </TableTr>
            ))}
          </TableTbody>
        </Table>
      </TableScrollContainer>
    </>
  );
}
