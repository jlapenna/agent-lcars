'use server';

import { createServerFunctionable } from '@orpc/next';

import { scheduleRouter } from '@/lib/schedule-router';

import { context } from '../context';

const functionable = createServerFunctionable({ context });

const createScheduleFn = functionable(scheduleRouter.create);
const listSchedulesFn = functionable(scheduleRouter.list);
const enableScheduleFn = functionable(scheduleRouter.enable);
const disableScheduleFn = functionable(scheduleRouter.disable);

// One-line forwarders, not a behavioral difference from the four
// procedures above: this repo's `fleet/use-server-actions-only` lint rule
// requires every export of a file-level 'use server' module to be a
// literal async function (see `work/actions.ts`'s identical comment).
export async function createSchedule(
  input: Parameters<typeof createScheduleFn>[0],
) {
  return createScheduleFn(input);
}
export async function listSchedules(
  input: Parameters<typeof listSchedulesFn>[0],
) {
  return listSchedulesFn(input);
}
export async function enableSchedule(
  input: Parameters<typeof enableScheduleFn>[0],
) {
  return enableScheduleFn(input);
}
export async function disableSchedule(
  input: Parameters<typeof disableScheduleFn>[0],
) {
  return disableScheduleFn(input);
}
