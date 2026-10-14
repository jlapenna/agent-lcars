import type { WorkSpec } from '@agent-lcars/work';
import {
  Anchor,
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

import { type ScheduleAction, ScheduleActions } from './schedule-actions';
import { type UpdateScheduleAction } from './schedule-create-form';
import { ScheduleTime } from './schedule-time';

export interface ScheduleView {
  id: string;
  cron: string;
  // Optional: a stored spec that no longer validates (see `viewSafe`,
  // `schedule-router.ts`) is omitted by the server rather than 500ing the
  // whole page -- the row below still renders the rest of the schedule so
  // an operator can find and disable it.
  spec?: WorkSpec;
  enabled: boolean;
  revision: number;
  disabledReason?: 'grant-revoked' | 'operator' | 'invalid';
  nextDueAt?: string;
  pendingItemId?: string;
  lastItemId?: string;
  lastClosedSlotAt?: string;
}

/** The `/work/schedules` list table: server-safe (no hooks), so the page
 *  can render it directly from the server-fetched `listSchedules` result. */
export function ScheduleList({
  schedules,
  enable,
  disable,
  update,
  remove,
}: {
  schedules: ScheduleView[];
  enable: ScheduleAction;
  disable: ScheduleAction;
  update: UpdateScheduleAction;
  remove: ScheduleAction;
}) {
  if (schedules.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No schedules yet.
      </Text>
    );
  }

  return (
    <TableScrollContainer
      minWidth={640}
      className="work-schedules-table-scroll"
    >
      <Table striped highlightOnHover verticalSpacing="xs" fz="sm">
        <TableThead>
          <TableTr>
            <TableTh>Title</TableTh>
            <TableTh>Cron</TableTh>
            <TableTh>Pipeline</TableTh>
            <TableTh>Repo</TableTh>
            <TableTh>Enabled</TableTh>
            <TableTh>Next occurrence</TableTh>
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
              <TableTd>
                <Stack gap={2}>
                  <Text size="xs">{schedule.enabled ? 'yes' : 'no'}</Text>
                  {schedule.disabledReason && (
                    <Text size="xs" c="dimmed">
                      {
                        (
                          {
                            operator: 'Disabled by an operator',
                            'grant-revoked':
                              'Creator grant revoked or repository unavailable',
                            invalid: 'Invalid schedule; edit to repair',
                          } as const
                        )[schedule.disabledReason]
                      }
                    </Text>
                  )}
                  {schedule.lastClosedSlotAt && (
                    <Text size="xs" c="dimmed">
                      A prior occurrence was closed for future admission. Work
                      admitted earlier may still finish.
                    </Text>
                  )}
                  {schedule.pendingItemId && (
                    <Text size="xs">
                      An admitted occurrence is still settling.
                    </Text>
                  )}
                </Stack>
              </TableTd>
              <TableTd>
                <ScheduleTime value={schedule.nextDueAt} />
              </TableTd>
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
                  schedule={schedule}
                  enable={enable}
                  disable={disable}
                  update={update}
                  remove={remove}
                />
              </TableTd>
            </TableTr>
          ))}
        </TableTbody>
      </Table>
    </TableScrollContainer>
  );
}
