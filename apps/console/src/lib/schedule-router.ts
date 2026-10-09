import 'server-only';

import { logger } from '@agent-lcars/logging';
import type { Schedule } from '@agent-lcars/orchestrator';
import {
  latestDueSlot,
  nextDueSlot,
  parseCron,
  schedulesContract,
  slotItemId,
  type WorkSpec,
  workSpecSchema,
} from '@agent-lcars/work';
import { implement, ORPCError } from '@orpc/server';

import { grantForPrincipal } from './work-grants';
import { forbiddenReason, mintItem, type WorkContext } from './work-mint';

const os = implement(schedulesContract).$context<WorkContext>();
const operator = os.use(async ({ context, next }) => {
  if (
    context.principal === undefined ||
    !context.principal.scopes.has('work.operator')
  ) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.operator scope required',
    });
  }
  return next({ context: { principal: context.principal } });
});
const cronTick = os.use(async ({ context, next }) => {
  if (
    context.principal === undefined ||
    !context.principal.scopes.has('work.cron')
  ) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.cron scope required',
    });
  }
  return next({ context });
});

function samePending(
  current: Schedule['pendingTick'],
  admitted: NonNullable<Schedule['pendingTick']>,
): boolean {
  return (
    current !== undefined &&
    current.itemId === admitted.itemId &&
    current.slotAt === admitted.slotAt &&
    current.revision === admitted.revision &&
    current.createdBy === admitted.createdBy &&
    JSON.stringify(current.spec) === JSON.stringify(admitted.spec)
  );
}
function laterSlot(previous: string | undefined, slot: string): string {
  return previous === undefined || new Date(previous) < new Date(slot)
    ? slot
    : previous;
}
function requiredPrincipal(context: WorkContext) {
  if (context.principal === undefined) throw new ORPCError('UNAUTHORIZED');
  return context.principal;
}
function admissionWatermark(schedule: Schedule): string | undefined {
  const marks = [schedule.lastSlotAt, schedule.lastClosedSlotAt].filter(
    (value): value is string => value !== undefined,
  );
  return marks.length === 0 ? undefined : marks.sort().at(-1);
}
async function closePending(
  context: WorkContext,
  id: string,
  admitted: NonNullable<Schedule['pendingTick']>,
  reason: 'invalid' | 'grant-revoked',
  now: Date,
) {
  return context.scheduleStore.mutateSchedule(id, (current) => {
    if (current === undefined || !samePending(current.pendingTick, admitted))
      return undefined;
    const { pendingTick: _pending, ...rest } = current;
    const disable =
      current.enabled &&
      current.deletedAt === undefined &&
      (current.revision ?? 0) === admitted.revision;
    return {
      ...rest,
      // Closing future admission does not cancel work a concurrent tick
      // already admitted. Preserve the successful-mint watermark separately.
      lastClosedSlotAt: laterSlot(current.lastClosedSlotAt, admitted.slotAt),
      ...(disable
        ? {
            enabled: false,
            disabledReason: reason,
            revision: (current.revision ?? 0) + 1,
            updatedAt: now.toISOString(),
          }
        : {}),
    };
  });
}
function nextDueAt(schedule: Schedule, now: Date): string | undefined {
  if (!schedule.enabled) return undefined;
  try {
    const after = Math.max(
      now.getTime(),
      new Date(admissionWatermark(schedule) ?? schedule.createdAt).getTime() +
        1,
      new Date(schedule.pendingTick?.slotAt ?? schedule.createdAt).getTime() +
        1,
    );
    // nextDueSlot truncates to the minute; round up and remain strictly after
    // the settled/admitted slot so the display never promises its replay.
    const from = new Date(Math.ceil(after / 60_000) * 60_000);
    return nextDueSlot(parseCron(schedule.cron), from)?.toISOString();
  } catch {
    return undefined;
  }
}
function viewSafe(schedule: Schedule, now: Date) {
  const parsed = workSpecSchema.safeParse(schedule.spec);
  const due = nextDueAt(schedule, now);
  return {
    id: schedule.scheduleId,
    cron: schedule.cron,
    ...(parsed.success ? { spec: parsed.data } : {}),
    enabled: schedule.enabled,
    createdBy: schedule.createdBy,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    revision: schedule.revision ?? 0,
    ...(schedule.lastSlotAt === undefined
      ? {}
      : { lastSlotAt: schedule.lastSlotAt }),
    ...(schedule.lastItemId === undefined
      ? {}
      : { lastItemId: schedule.lastItemId }),
    ...(schedule.disabledReason === undefined
      ? {}
      : { disabledReason: schedule.disabledReason }),
    ...(schedule.lastClosedSlotAt === undefined
      ? {}
      : { lastClosedSlotAt: schedule.lastClosedSlotAt }),
    ...(due === undefined ? {} : { nextDueAt: due }),
    ...(schedule.pendingTick === undefined
      ? {}
      : { pendingItemId: schedule.pendingTick.itemId }),
  };
}
function checkedCron(cron: string, now: Date) {
  try {
    if (nextDueSlot(parseCron(cron), now) !== undefined) return;
  } catch {
    throw new ORPCError('BAD_REQUEST', {
      message: 'Malformed cron expression',
    });
  }
  throw new ORPCError('BAD_REQUEST', {
    message: 'cron expression never fires within a year',
  });
}
function currentSchedule(
  current: Schedule | undefined,
  expectedRevision?: number,
): Schedule {
  if (current === undefined || current.deletedAt !== undefined)
    throw new ORPCError('NOT_FOUND');
  if (
    expectedRevision !== undefined &&
    (current.revision ?? 0) !== expectedRevision
  ) {
    throw new ORPCError('CONFLICT', {
      message: 'Schedule changed; reload before applying your change',
    });
  }
  return current;
}
function authorizeSchedule(context: WorkContext, schedule: Schedule) {
  // The creator can remove/repair their invalid or revoked schedule. Other
  // operators require a grant covering its stored pipeline and repository.
  if (context.principal?.principal === schedule.createdBy) return;
  const parsed = workSpecSchema.safeParse(schedule.spec);
  if (
    !parsed.success ||
    forbiddenReason(requiredPrincipal(context), parsed.data) !== undefined
  ) {
    throw new ORPCError('FORBIDDEN', { message: 'No grant for this schedule' });
  }
}
function authorizeSpec(context: WorkContext, spec: WorkSpec) {
  const forbidden = forbiddenReason(requiredPrincipal(context), spec);
  if (forbidden !== undefined)
    throw new ORPCError('FORBIDDEN', { message: forbidden });
}
function enabledConfiguration(
  context: WorkContext,
  schedule: Pick<Schedule, 'cron' | 'spec' | 'createdBy'>,
) {
  const parsed = workSpecSchema.safeParse(schedule.spec);
  if (!parsed.success)
    throw new ORPCError('BAD_REQUEST', {
      message: 'Repair the invalid schedule before enabling it',
    });
  checkedCron(schedule.cron, context.now());
  authorizeSpec(context, parsed.data);
  const grant = grantForPrincipal(schedule.createdBy, context.grants());
  const forbidden = forbiddenReason(
    { principal: schedule.createdBy, pipelines: grant?.pipelines ?? [] },
    parsed.data,
  );
  if (forbidden !== undefined)
    throw new ORPCError('FORBIDDEN', {
      message:
        'The schedule creator no longer has a grant for this pipeline or repository',
    });
}
function withoutReason(schedule: Schedule) {
  const { disabledReason: _reason, ...rest } = schedule;
  return rest;
}
async function toggle(
  context: WorkContext,
  id: string,
  expectedRevision: number,
  enabled: boolean,
) {
  const next = await context.scheduleStore.mutateSchedule(id, (current) => {
    const schedule = currentSchedule(current, expectedRevision);
    authorizeSchedule(context, schedule);
    if (enabled) enabledConfiguration(context, schedule);
    return {
      ...withoutReason(schedule),
      enabled,
      ...(enabled ? {} : { disabledReason: 'operator' as const }),
      revision: (schedule.revision ?? 0) + 1,
      updatedAt: context.now().toISOString(),
    };
  });
  return viewSafe(currentSchedule(next), context.now());
}

export const scheduleRouter = os.router({
  create: operator.create.handler(async ({ input, context }) => {
    authorizeSpec(context, input.spec);
    checkedCron(input.cron, context.now());
    const now = context.now().toISOString();
    const next = await context.scheduleStore.mutateSchedule(
      input.id,
      (existing) => {
        if (existing !== undefined) {
          const parsed = workSpecSchema.safeParse(existing.spec);
          if (
            existing.deletedAt !== undefined ||
            !parsed.success ||
            existing.cron !== input.cron ||
            JSON.stringify(parsed.data) !== JSON.stringify(input.spec)
          ) {
            throw new ORPCError('CONFLICT', {
              message: `schedule ${input.id} already exists with a different cron or spec`,
            });
          }
          return existing;
        }
        return {
          scheduleId: input.id,
          cron: input.cron,
          spec: input.spec,
          enabled: input.enabled ?? true,
          createdBy: context.principal.principal,
          createdAt: now,
          updatedAt: now,
          lastSlotAt: now,
          revision: 1,
        };
      },
    );
    return viewSafe(currentSchedule(next), context.now());
  }),
  get: operator.get.handler(async ({ input, context }) =>
    viewSafe(
      currentSchedule(await context.scheduleStore.readSchedule(input.id)),
      context.now(),
    ),
  ),
  list: operator.list.handler(async ({ input, context }) => ({
    schedules: (await context.scheduleStore.listSchedules(input.limit)).map(
      (schedule) => viewSafe(schedule, context.now()),
    ),
  })),
  update: operator.update.handler(async ({ input, context }) => {
    authorizeSpec(context, input.spec);
    checkedCron(input.cron, context.now());
    const next = await context.scheduleStore.mutateSchedule(
      input.id,
      (current) => {
        const schedule = currentSchedule(current, input.expectedRevision);
        authorizeSchedule(context, schedule);
        if (input.enabled)
          enabledConfiguration(context, {
            cron: input.cron,
            spec: input.spec,
            createdBy: schedule.createdBy,
          });
        return {
          ...withoutReason(schedule),
          cron: input.cron,
          spec: input.spec,
          enabled: input.enabled,
          ...(input.enabled ? {} : { disabledReason: 'operator' as const }),
          updatedAt: context.now().toISOString(),
          revision: (schedule.revision ?? 0) + 1,
        };
      },
    );
    return viewSafe(currentSchedule(next), context.now());
  }),
  delete: operator.delete.handler(async ({ input, context }) => {
    const next = await context.scheduleStore.mutateSchedule(
      input.id,
      (current) => {
        const schedule = currentSchedule(current, input.expectedRevision);
        authorizeSchedule(context, schedule);
        return {
          ...schedule,
          enabled: false,
          disabledReason: 'operator',
          deletedAt: context.now().toISOString(),
          updatedAt: context.now().toISOString(),
          revision: (schedule.revision ?? 0) + 1,
        };
      },
    );
    return {
      id: input.id,
      deleted: true as const,
      ...(next?.pendingTick === undefined
        ? {}
        : { pendingItemId: next.pendingTick.itemId }),
    };
  }),
  enable: operator.enable.handler(({ input, context }) =>
    toggle(context, input.id, input.expectedRevision, true),
  ),
  disable: operator.disable.handler(({ input, context }) =>
    toggle(context, input.id, input.expectedRevision, false),
  ),
  tick: cronTick.tick.handler(async ({ context }) => {
    const schedules = await context.scheduleStore.listTickSchedules();
    const now = context.now();
    const minted: { scheduleId: string; itemId: string }[] = [];
    const disabled: string[] = [];
    const errors: { scheduleId: string; message: string }[] = [];
    for (const snapshot of schedules) {
      try {
        let pending = snapshot.pendingTick;
        if (pending === undefined) {
          let spec: WorkSpec;
          let slot: Date | undefined;
          const watermark = admissionWatermark(snapshot);
          try {
            spec = workSpecSchema.parse(snapshot.spec);
            const cron = parseCron(snapshot.cron);
            if (nextDueSlot(cron, now) === undefined)
              throw new Error('cron expression never fires');
            slot = latestDueSlot(
              cron,
              now,
              watermark === undefined ? undefined : new Date(watermark),
            );
          } catch {
            const changed = await context.scheduleStore.mutateSchedule(
              snapshot.scheduleId,
              (current) => {
                if (
                  current === undefined ||
                  !current.enabled ||
                  current.deletedAt !== undefined ||
                  (current.revision ?? 0) !== (snapshot.revision ?? 0)
                )
                  return undefined;
                return {
                  ...current,
                  enabled: false,
                  disabledReason: 'invalid',
                  revision: (current.revision ?? 0) + 1,
                  updatedAt: now.toISOString(),
                };
              },
            );
            if (changed !== undefined) disabled.push(snapshot.scheduleId);
            continue;
          }
          if (slot === undefined) continue;
          const itemId = await slotItemId(snapshot.scheduleId, slot);
          const admitted = await context.scheduleStore.mutateSchedule(
            snapshot.scheduleId,
            (current) => {
              if (
                current === undefined ||
                !current.enabled ||
                current.deletedAt !== undefined ||
                current.pendingTick !== undefined ||
                (current.revision ?? 0) !== (snapshot.revision ?? 0) ||
                (admissionWatermark(current) ?? '') >= slot.toISOString()
              )
                return undefined;
              return {
                ...current,
                pendingTick: {
                  slotAt: slot.toISOString(),
                  itemId,
                  revision: current.revision ?? 0,
                  spec,
                  createdBy: current.createdBy,
                },
              };
            },
          );
          pending = admitted?.pendingTick;
          if (pending === undefined) continue;
        }
        // The atomic pending record is the tick's admission point. Changes
        // after it affect future occurrences; this one retries the frozen
        // spec even after a delete, and never vanishes on a crash.
        const admitted = pending;
        const parsed = workSpecSchema.safeParse(admitted.spec);
        if (!parsed.success) {
          const changed = await closePending(
            context,
            snapshot.scheduleId,
            admitted,
            'invalid',
            now,
          );
          if (changed?.disabledReason === 'invalid')
            disabled.push(snapshot.scheduleId);
          errors.push({
            scheduleId: snapshot.scheduleId,
            message:
              'Invalid admitted schedule specification; occurrence closed',
          });
          continue;
        }
        const spec = parsed.data;
        const grant = grantForPrincipal(admitted.createdBy, context.grants());
        const result = await mintItem(context, {
          id: admitted.itemId,
          spec,
          origin: { principal: `cron:${snapshot.scheduleId}`, channel: 'cron' },
          grantsPrincipal: {
            principal: admitted.createdBy,
            pipelines: grant?.pipelines ?? [],
          },
        });
        if (result.kind === 'forbidden') {
          // Another tick may have minted before this caller's grant snapshot.
          // Reconcile that durable result first; a denied retry cannot undo it.
          const task = await context.runtime.store.readTask({
            workId: admitted.itemId,
          });
          if (task === undefined) {
            const changed = await closePending(
              context,
              snapshot.scheduleId,
              admitted,
              'grant-revoked',
              now,
            );
            if (changed?.disabledReason === 'grant-revoked')
              disabled.push(snapshot.scheduleId);
            continue;
          }
          const stored = workSpecSchema.safeParse(
            (task.task.work as { spec?: unknown } | undefined)?.spec,
          );
          if (
            !stored.success ||
            JSON.stringify(stored.data) !== JSON.stringify(spec)
          )
            throw new Error(
              'scheduled item conflicts with the admitted occurrence',
            );
        }
        if (result.kind === 'conflict') {
          // A duplicate-request race is safe only if the actual item matches
          // this frozen reservation; an arbitrary same-id conflict must not
          // consume the schedule watermark or claim success.
          const task = await context.runtime.store.readTask({
            workId: admitted.itemId,
          });
          const stored = workSpecSchema.safeParse(
            (task?.task.work as { spec?: unknown } | undefined)?.spec,
          );
          if (
            !stored.success ||
            JSON.stringify(stored.data) !== JSON.stringify(spec)
          )
            throw new Error(
              'scheduled item conflicts with the admitted occurrence',
            );
        }
        const settled = await context.scheduleStore.mutateSchedule(
          snapshot.scheduleId,
          (current) => {
            if (
              current === undefined ||
              !samePending(current.pendingTick, admitted)
            )
              return undefined;
            const { pendingTick: _pending, ...rest } = current;
            return {
              ...rest,
              lastSlotAt: laterSlot(current.lastSlotAt, admitted.slotAt),
              lastItemId: admitted.itemId,
              updatedAt: now.toISOString(),
            };
          },
        );
        if (settled !== undefined)
          minted.push({
            scheduleId: snapshot.scheduleId,
            itemId: admitted.itemId,
          });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('agent-lcars: schedule tick failed', {
          scheduleId: snapshot.scheduleId,
          error,
        });
        errors.push({ scheduleId: snapshot.scheduleId, message });
      }
    }
    return {
      ticked: schedules.length,
      minted,
      skippedCap: [] as string[],
      disabled,
      errors,
    };
  }),
});
