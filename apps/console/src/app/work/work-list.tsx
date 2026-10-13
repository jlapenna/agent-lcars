import type { ItemState, ItemView } from '@agent-lcars/work/derive';
import { latestRun } from '@agent-lcars/work/derive';
import {
  Anchor,
  Badge,
  Card,
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
  Title,
} from '@mantine/core';

import { ExecutionStatus } from '../execution-status';
import { RelativeTime } from '../relative-time';

/** parked < running < done < canceled - a parked item is the one most
 *  likely to need attention (it settled without success and nobody has
 *  redispatched it yet), so it sorts to the top of recent work. */
const STATE_ORDER: Record<ItemState, number> = {
  failed: -1,
  parked: 0,
  running: 1,
  done: 2,
  canceled: 3,
};

/** The mockup's state marks: a square of the status colour beside the label.
 *  Status colour, never the route accent. */
const STATE_TONE: Record<ItemState, string> = {
  running: 'busy',
  parked: 'warn',
  failed: 'fail',
  done: 'ok',
  canceled: 'idle',
};

type Priority = ItemView['spec']['priority'];

/** Queue position: urgent before normal before background, FIFO within. */
const PRIORITY_ORDER: Record<NonNullable<Priority>, number> = {
  urgent: 0,
  normal: 1,
  background: 2,
};

const PRIORITY_LABEL: Record<NonNullable<Priority>, string> = {
  urgent: 'P1',
  normal: 'P2',
  background: 'P3',
};

function priorityOf(item: ItemView): NonNullable<Priority> {
  return item.spec.priority ?? 'normal';
}

/** When the item's current run was admitted. A replied-to or redispatched
 * item is re-admitted by a new run, so its place in the queue and its
 * waiting age come from that run, not from the item's first creation. */
export function admittedAt(item: ItemView): string {
  return latestRun(item.runs)?.createdAt ?? item.createdAt;
}

function WorkExecution({ item }: { item: ItemView }) {
  const run = latestRun(item.runs);
  return run ? <ExecutionStatus run={run} /> : null;
}

function pipelineLabel(item: ItemView): string {
  const latest = latestRun(item.runs);
  return latest?.providerFallback?.trigger === undefined
    ? item.spec.pipeline
    : `${latest.pipeline} (fallback; requested ${item.spec.pipeline})`;
}

function PriorityMark({ item }: { item: ItemView }) {
  const priority = priorityOf(item);
  return (
    <span className="work-priority" title={priority}>
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

function StateMark({ item }: { item: ItemView }) {
  return (
    <span className="work-state" data-tone={STATE_TONE[item.state]}>
      {item.state}
    </span>
  );
}

function ItemCell({ item }: { item: ItemView }) {
  return (
    <>
      <span className="work-item-ref">
        {item.spec.target.repo} · {item.origin.principal}
      </span>
      <Anchor href={`/work/${item.id}`} className="work-item-title">
        {item.spec.title}
      </Anchor>
    </>
  );
}

/** One work item, laid out for a phone rather than truncated into a table
 *  row (same "cards below `sm`" split the sessions archive uses). */
function WorkCard({ item, admitted }: { item: ItemView; admitted: boolean }) {
  return (
    <article className="work-mobile-row" data-testid={`work-card-${item.id}`}>
      <Stack gap={4}>
        <Group justify="space-between" align="center" wrap="wrap" gap={6}>
          <StateMark item={item} />
          <Badge variant="default" size="xs">
            {pipelineLabel(item)}
          </Badge>
        </Group>
        <ItemCell item={item} />
        <WorkExecution item={item} />
        <Text size="xs" c="dimmed" className="work-mobile-row__meta">
          <PriorityMark item={item} /> · {admitted ? 'waiting ' : 'updated '}
          <RelativeTime
            iso={admitted ? admittedAt(item) : item.updatedAt}
            variant="compact"
          />
        </Text>
      </Stack>
    </article>
  );
}

function WorkTable({
  items,
  admitted,
}: {
  items: ItemView[];
  admitted: boolean;
}) {
  return (
    <TableScrollContainer minWidth={640} className="work-table-scroll">
      <Table
        highlightOnHover
        verticalSpacing="xs"
        fz="sm"
        className="work-table"
      >
        <TableThead>
          <TableTr>
            <TableTh>Pri</TableTh>
            <TableTh>Item</TableTh>
            <TableTh>Agent</TableTh>
            <TableTh>State</TableTh>
            <TableTh className="work-table__num">
              {admitted ? 'Waiting' : 'Updated'}
            </TableTh>
          </TableTr>
        </TableThead>
        <TableTbody>
          {items.map((item) => (
            <TableTr key={item.id}>
              <TableTd>
                <PriorityMark item={item} />
              </TableTd>
              <TableTd className="work-table__item">
                <ItemCell item={item} />
              </TableTd>
              <TableTd>
                <Badge variant="default" size="xs">
                  {pipelineLabel(item)}
                </Badge>
              </TableTd>
              <TableTd>
                <StateMark item={item} />
                <WorkExecution item={item} />
              </TableTd>
              <TableTd className="work-table__num">
                <RelativeTime
                  iso={admitted ? admittedAt(item) : item.updatedAt}
                  variant="compact"
                />
              </TableTd>
            </TableTr>
          ))}
        </TableTbody>
      </Table>
    </TableScrollContainer>
  );
}

function WorkPanel({
  title,
  items,
  meta,
  admitted,
}: {
  title: string;
  items: ItemView[];
  meta: string;
  admitted: boolean;
}) {
  return (
    <Card
      withBorder
      className="lcars-panel work-panel"
      data-testid={admitted ? 'work-admitted-queue' : 'work-recent'}
    >
      <Group
        gap={10}
        align="baseline"
        wrap="nowrap"
        className="work-panel__head"
      >
        <Title order={2}>{title}</Title>
        <span className="work-panel__count">{items.length}</span>
        <span className="work-panel__meta">{meta}</span>
      </Group>
      {items.length === 0 ? (
        <Text c="dimmed" size="sm" py="sm">
          {admitted ? 'Nothing admitted is waiting or running.' : 'None.'}
        </Text>
      ) : (
        <WorkTable items={items} admitted={admitted} />
      )}
    </Card>
  );
}

/** Admitted work - still running or waiting to run - in queue order. */
export function admittedQueue(items: ItemView[]): ItemView[] {
  return items
    .filter((item) => item.state === 'running')
    .sort(
      (a, b) =>
        PRIORITY_ORDER[priorityOf(a)] - PRIORITY_ORDER[priorityOf(b)] ||
        admittedAt(a).localeCompare(admittedAt(b)),
    );
}

/** Everything else: stopped work first, then most recently updated. */
export function recentWork(items: ItemView[]): ItemView[] {
  return items
    .filter((item) => item.state !== 'running')
    .sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
}

/**
 * The `/work` list as design/fleet-console.html draws it: an "Admitted
 * queue" panel (Pri · Item · Agent · State · Waiting) and the rest of the
 * page's items as "Recent work" in the same columns. Server-safe (no hooks).
 * Below `sm` both become one card list, with the same grouping.
 */
export function WorkList({ items }: { items: ItemView[] }) {
  if (items.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No work items yet.
      </Text>
    );
  }

  const queue = admittedQueue(items);
  const recent = recentWork(items);
  // Oldest across priorities, not the head of the queue.
  const oldest = queue
    .map(admittedAt)
    .reduce<string | undefined>(
      (min, at) => (min === undefined || at < min ? at : min),
      undefined,
    );

  return (
    <>
      <Stack gap={0} hiddenFrom="sm" data-testid="work-cards">
        {queue.length > 0 && (
          <Text className="lcars-eyebrow work-cards__group">
            Admitted queue · {queue.length}
          </Text>
        )}
        {queue.map((item) => (
          <WorkCard key={item.id} item={item} admitted />
        ))}
        {recent.length > 0 && (
          <Text className="lcars-eyebrow work-cards__group">
            Recent work · {recent.length}
          </Text>
        )}
        {recent.map((item) => (
          <WorkCard key={item.id} item={item} admitted={false} />
        ))}
      </Stack>

      <Stack gap={28} visibleFrom="sm" className="work-panels">
        <WorkPanel
          title="Admitted queue"
          items={queue}
          admitted
          meta={
            oldest
              ? `FIFO within priority · oldest ${relativeAge(oldest)}`
              : 'FIFO within priority'
          }
        />
        <WorkPanel
          title="Recent work"
          items={recent}
          admitted={false}
          meta="stopped first · then most recently updated"
        />
      </Stack>
    </>
  );
}

/** Server-rendered age for a panel caption; rows use RelativeTime. */
function relativeAge(iso: string): string {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - Date.parse(iso)) / 60_000),
  );
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `${hours}h ${minutes % 60}m`
    : `${Math.floor(hours / 24)}d`;
}
