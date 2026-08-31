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

/**
 * `view`, but for a caller that must survive a schedule whose stored
 * `spec` no longer validates. A `spec` tightened out from under an
 * already-stored schedule, or a hand-edited document, is exactly the
 * "invalid" case the tick handler already disables a schedule for; a
 * listing or a single `get`/`enable`/`disable` must not 500 over it the
 * way the strict `view` above would. This omits only `spec` -- the rest of the schedule
 * (id, cron, enabled, watermark) is still meaningful, and the operator
 * needs it to find and fix -- or simply disable -- the broken row.
 */
function viewSafe(schedule: Schedule) {
  const parsed = workSpecSchema.safeParse(schedule.spec);
  return {
    id: schedule.scheduleId,
    cron: schedule.cron,
    ...(parsed.success ? { spec: parsed.data } : {}),
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

/**
 * Re-reads a schedule immediately before a tick writes back to it (a
 * success watermark or an auto-disable): an operator's `disable` (or a
 * delete) landing between this schedule's `listEnabledSchedules()`
 * snapshot at the top of `tick` and now must win the race. Returns
 * `undefined` when it did -- gone, or no longer enabled -- so the caller
 * skips the write instead of resurrecting a disabled/deleted schedule
 * with a stale watermark; otherwise returns the fresh record, which the
 * write spreads onto instead of the loop's now-possibly-stale snapshot.
 */
async function freshEnabledOrSkip(
  context: WorkContext,
  scheduleId: string,
): Promise<Schedule | undefined> {
  const fresh = await context.scheduleStore.readSchedule(scheduleId);
  return fresh === undefined || !fresh.enabled ? undefined : fresh;
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
      // Seeded to the creation instant, not left `undefined`: `tick`'s
      // `latestDueSlot(cron, now, lastSlotAt)` only ever mints a boundary
      // strictly AFTER `lastSlotAt`, so a schedule's first slot is the
      // first boundary after its creation -- never one already in the
      // past at the moment it was created (see the spec's "Tick
      // semantics" section).
      lastSlotAt: now,
    };
    await context.scheduleStore.writeSchedule(schedule);
    return view(schedule);
  }),

  get: operator.get.handler(async ({ input, context, errors }) => {
    const schedule = await context.scheduleStore.readSchedule(input.id);
    if (schedule === undefined) throw errors.NOT_FOUND();
    return viewSafe(schedule);
  }),

  list: operator.list.handler(async ({ input, context }) => {
    const schedules = await context.scheduleStore.listSchedules(input.limit);
    return { schedules: schedules.map(viewSafe) };
  }),

  enable: operator.enable.handler(async ({ input, context, errors }) => {
    const schedule = await context.scheduleStore.readSchedule(input.id);
    if (schedule === undefined) throw errors.NOT_FOUND();
    // Clears `disabledReason` unconditionally, regardless of which reason
    // disabled it ('operator', 'grant-revoked', or 'invalid') -- the next
    // tick re-validates the grant and re-parses the stored cron/spec from
    // scratch, so there is nothing left here worth distinguishing.
    const { disabledReason: _disabledReason, ...rest } = schedule;
    const next: Schedule = {
      ...rest,
      enabled: true,
      updatedAt: context.now().toISOString(),
    };
    await context.scheduleStore.writeSchedule(next);
    return viewSafe(next);
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
    return viewSafe(next);
  }),

  tick: cronTick.tick.handler(async ({ context }) => {
    const schedules = await context.scheduleStore.listEnabledSchedules();
    const now = context.now();
    const minted: { scheduleId: string; itemId: string }[] = [];
    const skippedCap: string[] = [];
    const disabled: string[] = [];
    const tickErrors: { scheduleId: string; message: string }[] = [];

    for (const schedule of schedules) {
      // Everything below is per-schedule work (parsing the stored cron,
      // computing the due slot and item id, minting, writing the
      // watermark back) inside one try/catch: one schedule's failure --
      // an unexpected `mintItem` throw, a store write that rejects, ...
      // -- must never abort the remaining schedules' ticks. It is logged
      // with the scheduleId and reported in `errors` instead of thrown.
      try {
        // A stored `cron` is validated by `cronExpressionSchema` at create
        // time, so one that no longer parses here is not a caller mistake
        // -- it is a bug (a grammar tightened out from under an
        // already-stored schedule, or a hand-edited document). Disable
        // with 'invalid' rather than letting `parseCron` throw and abort
        // every other schedule's tick.
        let cron: CronSpec;
        try {
          cron = parseCron(schedule.cron);
        } catch (error) {
          console.error(
            'agent-lcars: schedule has a cron expression that no longer parses, disabling',
            { scheduleId: schedule.scheduleId, error },
          );
          const fresh = await freshEnabledOrSkip(context, schedule.scheduleId);
          if (fresh === undefined) continue;
          await context.scheduleStore.writeSchedule({
            ...fresh,
            enabled: false,
            disabledReason: 'invalid',
            updatedAt: now.toISOString(),
          });
          disabled.push(schedule.scheduleId);
          continue;
        }

        const lastSlotAt =
          schedule.lastSlotAt === undefined
            ? undefined
            : new Date(schedule.lastSlotAt);
        const slot = latestDueSlot(cron, now, lastSlotAt);
        if (slot === undefined) continue;

        const itemId = await slotItemId(schedule.scheduleId, slot);

        // Same reasoning as the cron case above: a stored `spec` is
        // validated with `workSpecSchema` at create time, so one that no
        // longer parses here is a bug in the stored data, disabled with
        // the same 'invalid' reason.
        let spec: WorkSpec;
        try {
          spec = workSpecSchema.parse(schedule.spec);
        } catch (error) {
          console.error(
            'agent-lcars: schedule has a spec that no longer validates, disabling',
            { scheduleId: schedule.scheduleId, error },
          );
          const fresh = await freshEnabledOrSkip(context, schedule.scheduleId);
          if (fresh === undefined) continue;
          await context.scheduleStore.writeSchedule({
            ...fresh,
            enabled: false,
            disabledReason: 'invalid',
            updatedAt: now.toISOString(),
          });
          disabled.push(schedule.scheduleId);
          continue;
        }

        const grant = grantForPrincipal(schedule.createdBy, context.grants());

        const result = await mintItem(context, {
          id: itemId,
          spec,
          origin: {
            principal: `cron:${schedule.scheduleId}`,
            channel: 'cron',
          },
          grantsPrincipal: {
            principal: schedule.createdBy,
            pipelines: grant?.pipelines ?? [],
          },
        });

        if (result.kind === 'forbidden') {
          const fresh = await freshEnabledOrSkip(context, schedule.scheduleId);
          if (fresh === undefined) continue;
          await context.scheduleStore.writeSchedule({
            ...fresh,
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
        // `result.kind === 'conflict'` is reachable here for exactly one
        // reason: `mintItem`'s own "existing item with a different spec"
        // conflict can never trigger -- `itemId` is deterministic per
        // (scheduleId, slot) (`slotItemId`), always paired with the same
        // `spec`, so a same-slot re-tick always replays the identical spec
        // `mintItem` already stored. What CAN: two ticks racing the
        // identical due slot both call `orchestrator.request` for the same
        // requestId, and the loser gets back the orchestrator's own
        // idempotency refusal, `reason: 'duplicate-request'`. Either way
        // the item already exists exactly as an uncontested mint would
        // have left it, so 'conflict' shares this write-back with
        // 'existing' (idempotent replay) and 'minted' (a fresh mint) --
        // every one of `MintOutcome`'s five kinds is matched explicitly by
        // a branch in this function.
        if (
          result.kind === 'conflict' ||
          result.kind === 'existing' ||
          result.kind === 'minted'
        ) {
          // Checked -- and, on a lost race, skipped -- BEFORE `minted` is
          // touched: an operator win here means this tick reports nothing,
          // not a phantom entry for a watermark it never wrote.
          const fresh = await freshEnabledOrSkip(context, schedule.scheduleId);
          if (fresh === undefined) continue;
          minted.push({ scheduleId: schedule.scheduleId, itemId });
          await context.scheduleStore.writeSchedule({
            ...fresh,
            lastSlotAt: slot.toISOString(),
            lastItemId: itemId,
            updatedAt: now.toISOString(),
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('agent-lcars: schedule tick failed', {
          scheduleId: schedule.scheduleId,
          error,
        });
        tickErrors.push({ scheduleId: schedule.scheduleId, message });
      }
    }

    return {
      ticked: schedules.length,
      minted,
      skippedCap,
      disabled,
      errors: tickErrors,
    };
  }),
});
