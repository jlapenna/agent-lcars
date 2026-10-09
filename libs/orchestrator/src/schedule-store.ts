import { z } from 'zod';

import { WORK_ID_RE } from './model';

const isoUtc = z.iso.datetime({ offset: false });

/** Same bound `Task.work` uses (`WORK_PAYLOAD_MAX_BYTES` in `model.ts`) --
 *  a schedule's `spec` is exactly a `WorkSpec`, minted on every due slot,
 *  so it must fit inside the same budget a one-shot item's payload does. */
export const SCHEDULE_SPEC_MAX_BYTES = 32_768;

const scheduleSpecSchema = z
  .record(z.string().max(64), z.unknown())
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <=
      SCHEDULE_SPEC_MAX_BYTES,
    { message: `schedule spec exceeds ${SCHEDULE_SPEC_MAX_BYTES} bytes` },
  );

/** A tick admitted atomically before an edit/disable/delete may finish with
 * this frozen configuration. Retained until mint settles, so a crash cannot
 * consume a watermark without creating its deterministic item. */
export const pendingScheduleTickSchema = z.strictObject({
  slotAt: isoUtc,
  itemId: z.string().regex(WORK_ID_RE),
  revision: z.number().int().nonnegative(),
  spec: scheduleSpecSchema,
  createdBy: z.string().min(1).max(128),
});

export const scheduleSchema = z.strictObject({
  scheduleId: z.string().regex(WORK_ID_RE),
  /** 5-field UTC cron expression; opaque here -- `@agent-lcars/work`'s
   *  `parseCron` is what interprets it. Bounded generously above any
   *  legal expression. */
  cron: z.string().min(1).max(64),
  /** A `WorkSpec`, opaque at this layer exactly as `Task.work.spec` is --
   *  see `model.ts`'s `workPayloadSchema` for the identical pattern.
   *  `@agent-lcars/work`'s schedule router parses it with `workSpecSchema`
   *  on every read and write. */
  spec: scheduleSpecSchema,
  enabled: z.boolean(),
  /** LCARS-native principal that created the schedule -- the identity
   *  grants are checked against at every tick, not the scheduler service
   *  principal's separate `work.cron` authority. */
  createdBy: z.string().min(1).max(128),
  createdAt: isoUtc,
  updatedAt: isoUtc,
  /** Configuration revision; missing historical revisions are zero. Ticks
   * preserve it. Operator changes and auto-disable decisions increment it. */
  revision: z.number().int().nonnegative().optional(),
  /** Deletion tombstone prevents reusing the id or reviving a stale tick.
   * A previously admitted pending occurrence is still retried to settlement. */
  deletedAt: isoUtc.optional(),
  pendingTick: pendingScheduleTickSchema.optional(),
  /** The latest due slot a tick has already minted for. Absent means
   *  "never ticked". */
  lastSlotAt: isoUtc.optional(),
  lastItemId: z.string().regex(WORK_ID_RE).optional(),
  /** Admission floor for a terminal invalid/revoked occurrence. Prevents
   * reusing its deterministic slot under a later configuration, while work
   * admitted concurrently before closure may still finish. This is separate
   * from lastSlotAt/lastItemId, which describe successful mint settlement. */
  lastClosedSlotAt: isoUtc.optional(),
  /** Set by a tick that auto-disables the schedule once its creator's
   *  grant no longer covers it ('grant-revoked'), by a tick that finds the
   *  stored `cron` or `spec` no longer parses ('invalid' -- a schema
   *  tightened out from under an already-stored schedule, or a hand-edited
   *  document), or by the operator disable route ('operator'). */
  disabledReason: z.enum(['grant-revoked', 'operator', 'invalid']).optional(),
});
export type Schedule = z.infer<typeof scheduleSchema>;

/** Schedule configuration and pending-slot admission share one atomic owner.
 * The callback is synchronous/pure and may be retried by Firestore; it must
 * never mint work or perform external effects. undefined means no write. */
export interface ScheduleStore {
  readSchedule(scheduleId: string): Promise<Schedule | undefined>;
  mutateSchedule(
    scheduleId: string,
    change: (current: Schedule | undefined) => Schedule | undefined,
  ): Promise<Schedule | undefined>;
  /** Low-level fixture/import writer. Runtime mutations use mutateSchedule. */
  writeSchedule(schedule: Schedule): Promise<void>;
  /** Newest first; deleted schedules are hidden. */
  listSchedules(limit?: number): Promise<Schedule[]>;
  listEnabledSchedules(): Promise<Schedule[]>;
  /** Enabled schedules plus durable pending occurrences, including deleted
   * schedules whose tick was admitted before deletion. */
  listTickSchedules(): Promise<Schedule[]>;
}
