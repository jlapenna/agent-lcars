import type { ItemState, ItemView } from '@agent-lcars/work/derive';
import {
  Anchor,
  Table,
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

/**
 * The `/work` list table: server-safe (no hooks), so the page can render it
 * directly from the server-fetched `listItems` result.
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
    <Table striped highlightOnHover verticalSpacing="xs" fz="sm">
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
  );
}
