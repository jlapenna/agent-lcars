import 'server-only';

import type { Schedule } from '@agent-lcars/orchestrator';
import {
  type CronSpec,
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
  const { principal } = context;
  if (principal === undefined || !principal.scopes.has('work.operator')) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.operator scope required',
    });
  }
  return next({ context: { principal } });
});

const cronTick = os.use(async ({ context, next }) => {
  const { principal } = context;
  if (principal === undefined || !principal.scopes.has('work.cron')) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.cron scope required',
    });
  }
  return next({ context });
});

function view(schedule: Schedule) {
  return {
    id: schedule.scheduleId,
    cron: schedule.cron,
    spec: workSpecSchema.parse(schedule.spec),
    enabled: schedule.enabled,
    createdBy: schedule.createdBy,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    ...(schedule.lastSlotAt === undefined
      ? {}
      : { lastSlotAt: schedule.lastSlotAt }),
    ...(schedule.lastItemId === undefined
      ? {}
      : { lastItemId: schedule.lastItemId }),
    ...(schedule.disabledReason === undefined
      ? {}
      : { disabledReason: schedule.disabledReason }),
  };
}

function sameSchedule(
  a: Schedule,
  b: { cron: string; spec: unknown },
): boolean {
  return (
    a.cron === b.cron &&
    JSON.stringify(workSpecSchema.parse(a.spec)) ===
      JSON.stringify(workSpecSchema.parse(b.spec))
  );
}

export const scheduleRouter = os.router({
  create: operator.create.handler(async ({ input, context, errors }) => {
    const { principal } = context;
    // The same check `items.create` runs: pipeline grant + control-plane
    // repo admission. One ruling, one function -- `schedule-router.ts`
    // does not fork it.
    const forbidden = forbiddenReason(principal, input.spec);
    if (forbidden !== undefined) throw errors.FORBIDDEN({ message: forbidden });

    // `cronExpressionSchema` (Task 3) already refuses a malformed
    // expression before the handler runs; re-parsing here is what lets
    // this throw the exact documented BAD_REQUEST message rather than
    // trusting zod's own refine message. It also produces the `CronSpec`
    // `nextDueSlot` needs next.
    let cron: CronSpec;
    try {
      cron = parseCron(input.cron);
    } catch {
      throw errors.BAD_REQUEST({ message: 'Malformed cron expression' });
    }
    // A syntactically valid expression that can never actually fire (e.g.
    // `0 0 31 2 *` -- no February has a 31st) would otherwise sit enabled
    // forever, costing a full `MAX_LOOKBACK_MINUTES` walk on every tick
    // for nothing. Reject it once, here, instead.
    if (nextDueSlot(cron, context.now()) === undefined) {
      throw errors.BAD_REQUEST({
        message: 'cron expression never fires within a year',
      });
    }

    const existing = await context.scheduleStore.readSchedule(input.id);
    if (existing !== undefined) {
      if (!sameSchedule(existing, { cron: input.cron, spec: input.spec })) {
        throw errors.CONFLICT({
          message: `schedule ${input.id} already exists with a different cron or spec`,
        });
      }
      return view(existing);
    }

    const now = context.now().toISOString();
    const schedule: Schedule = {
      scheduleId: input.id,
      cron: input.cron,
      spec: input.spec,
      enabled: input.enabled ?? true,
      createdBy: principal.principal,
      createdAt: now,
      updatedAt: now,
    };
    await context.scheduleStore.writeSchedule(schedule);
    return view(schedule);
  }),

  get: operator.get.handler(async ({ input, context, errors }) => {
    const schedule = await context.scheduleStore.readSchedule(input.id);
    if (schedule === undefined) throw errors.NOT_FOUND();
    return view(schedule);
  }),

  list: operator.list.handler(async ({ input, context }) => {
    const schedules = await context.scheduleStore.listSchedules(input.limit);
    return { schedules: schedules.map(view) };
  }),

  enable: operator.enable.handler(async ({ input, context, errors }) => {
    const schedule = await context.scheduleStore.readSchedule(input.id);
    if (schedule === undefined) throw errors.NOT_FOUND();
    const { disabledReason: _disabledReason, ...rest } = schedule;
    const next: Schedule = {
      ...rest,
      enabled: true,
      updatedAt: context.now().toISOString(),
    };
    await context.scheduleStore.writeSchedule(next);
    return view(next);
  }),

  disable: operator.disable.handler(async ({ input, context, errors }) => {
    const schedule = await context.scheduleStore.readSchedule(input.id);
    if (schedule === undefined) throw errors.NOT_FOUND();
    const next: Schedule = {
      ...schedule,
      enabled: false,
      disabledReason: 'operator',
      updatedAt: context.now().toISOString(),
    };
    await context.scheduleStore.writeSchedule(next);
    return view(next);
  }),

  tick: cronTick.tick.handler(async ({ context }) => {
    const schedules = await context.scheduleStore.listEnabledSchedules();
    const now = context.now();
    const minted: { scheduleId: string; itemId: string }[] = [];
    const skippedCap: string[] = [];
    const disabled: string[] = [];

    for (const schedule of schedules) {
      const cron = parseCron(schedule.cron);
      const lastSlotAt =
        schedule.lastSlotAt === undefined
          ? undefined
          : new Date(schedule.lastSlotAt);
      const slot = latestDueSlot(cron, now, lastSlotAt);
      if (slot === undefined) continue;

      const itemId = await slotItemId(schedule.scheduleId, slot);

      // A stored `spec` is validated with `workSpecSchema` at create time
      // (`view`/`sameSchedule` above), so a spec that no longer parses
      // here is not a caller mistake -- it is a bug (a schema tightened
      // out from under an already-stored schedule, or a hand-edited
      // Firestore document). `schedulesContract`'s tick response has no
      // field for "this schedule's stored data is corrupt" separate from
      // "this schedule is disabled", so the closest fit it does support is
      // the same `disabled` list a grant revocation uses, with the only
      // other `disabledReason` the schema allows.
      let spec: WorkSpec;
      try {
        spec = workSpecSchema.parse(schedule.spec);
      } catch (error) {
        console.error(
          'agent-lcars: schedule has a spec that no longer validates, disabling',
          { scheduleId: schedule.scheduleId, error },
        );
        await context.scheduleStore.writeSchedule({
          ...schedule,
          enabled: false,
          disabledReason: 'operator',
          updatedAt: now.toISOString(),
        });
        disabled.push(schedule.scheduleId);
        continue;
      }

      const grant = grantForPrincipal(schedule.createdBy, context.grants());

      const result = await mintItem(context, {
        id: itemId,
        spec,
        origin: { principal: `cron:${schedule.scheduleId}`, channel: 'cron' },
        grantsPrincipal: {
          principal: schedule.createdBy,
          pipelines: grant?.pipelines ?? [],
        },
      });

      if (result.kind === 'forbidden') {
        await context.scheduleStore.writeSchedule({
          ...schedule,
          enabled: false,
          disabledReason: 'grant-revoked',
          updatedAt: now.toISOString(),
        });
        disabled.push(schedule.scheduleId);
        continue;
      }
      if (result.kind === 'cap') {
        skippedCap.push(schedule.scheduleId);
        continue;
      }
      // 'conflict' cannot happen here: `itemId` is deterministic per
      // (scheduleId, slot) -- see `slotItemId` -- so a same-slot re-tick
      // always replays the identical spec `mintItem` already stored.
      minted.push({ scheduleId: schedule.scheduleId, itemId });
      await context.scheduleStore.writeSchedule({
        ...schedule,
        lastSlotAt: slot.toISOString(),
        lastItemId: itemId,
        updatedAt: now.toISOString(),
      });
    }

    return { ticked: schedules.length, minted, skippedCap, disabled };
  }),
});
