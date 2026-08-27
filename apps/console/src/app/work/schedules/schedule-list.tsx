import type { WorkSpec } from '@agent-lcars/work';
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

import { type ScheduleAction, ScheduleActions } from './schedule-actions';

export interface ScheduleView {
  id: string;
  cron: string;
  // Optional: a stored spec that no longer validates (see `viewSafe`,
  // `schedule-router.ts`) is omitted by the server rather than 500ing the
  // whole page -- the row below still renders the rest of the schedule so
  // an operator can find and disable it.
  spec?: WorkSpec;
  enabled: boolean;
  lastItemId?: string;
}

/** The `/work/schedules` list table: server-safe (no hooks), so the page
 *  can render it directly from the server-fetched `listSchedules` result. */
export function ScheduleList({
  schedules,
  enable,
  disable,
}: {
  schedules: ScheduleView[];
  enable: ScheduleAction;
  disable: ScheduleAction;
}) {
  if (schedules.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No schedules yet.
      </Text>
    );
  }

  return (
    <Table striped highlightOnHover verticalSpacing="xs" fz="sm">
      <TableThead>
        <TableTr>
          <TableTh>Title</TableTh>
          <TableTh>Cron</TableTh>
          <TableTh>Pipeline</TableTh>
          <TableTh>Repo</TableTh>
          <TableTh>Enabled</TableTh>
          <TableTh>Last item</TableTh>
          <TableTh />
        </TableTr>
      </TableThead>
      <TableTbody>
        {schedules.map((schedule) => (
          <TableTr key={schedule.id}>
            <TableTd>{schedule.spec?.title ?? '—'}</TableTd>
            <TableTd>
              <code>{schedule.cron}</code>
            </TableTd>
            <TableTd>{schedule.spec?.pipeline ?? '—'}</TableTd>
            <TableTd>{schedule.spec?.target.repo ?? '—'}</TableTd>
            <TableTd>{schedule.enabled ? 'yes' : 'no'}</TableTd>
            <TableTd>
              {schedule.lastItemId ? (
                <Anchor href={`/work/${schedule.lastItemId}`} size="sm">
                  {schedule.lastItemId}
                </Anchor>
              ) : (
                <Text c="dimmed" size="sm">
                  never
                </Text>
              )}
            </TableTd>
            <TableTd>
              <ScheduleActions
                id={schedule.id}
                enabled={schedule.enabled}
                enable={enable}
                disable={disable}
              />
            </TableTd>
          </TableTr>
        ))}
      </TableTbody>
    </Table>
  );
}
