import { z } from 'zod';

import { WORK_ID_RE } from './model';

const isoUtc = z.iso.datetime({ offset: false });

/** Same bound `Task.work` uses (`WORK_PAYLOAD_MAX_BYTES` in `model.ts`) --
 *  a schedule's `spec` is exactly a `WorkSpec`, minted on every due slot,
 *  so it must fit inside the same budget a one-shot item's payload does. */
export const SCHEDULE_SPEC_MAX_BYTES = 32_768;

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
  spec: z
    .record(z.string().max(64), z.unknown())
    .refine(
      (value) =>
        new TextEncoder().encode(JSON.stringify(value)).length <=
        SCHEDULE_SPEC_MAX_BYTES,
      { message: `schedule spec exceeds ${SCHEDULE_SPEC_MAX_BYTES} bytes` },
    ),
  enabled: z.boolean(),
  /** LCARS-native principal that created the schedule -- the identity
   *  grants are checked against at every tick, never the tick caller's
   *  own `cron:tick` identity, which has no grant of its own. */
  createdBy: z.string().min(1).max(128),
  createdAt: isoUtc,
  updatedAt: isoUtc,
  /** The latest due slot a tick has already minted for. Absent means
   *  "never ticked". */
  lastSlotAt: isoUtc.optional(),
  lastItemId: z.string().regex(WORK_ID_RE).optional(),
  /** Set by a tick that auto-disables the schedule once its creator's
   *  grant no longer covers it ('grant-revoked'), or by the operator
   *  disable route ('operator'). */
  disabledReason: z.enum(['grant-revoked', 'operator']).optional(),
});
export type Schedule = z.infer<typeof scheduleSchema>;

/**
 * Durability boundary for schedules, parallel to `OrchestratorStore` but
 * deliberately a separate interface: a schedule is not a `Task`, has no
 * mutex, and the tick's read/mint/write-back cycle needs nothing an
 * `OrchestratorStore` implementation provides.
 */
export interface ScheduleStore {
  readSchedule(scheduleId: string): Promise<Schedule | undefined>;
  /** Create-or-replace. No version/updatedAt guard -- every writer
   *  (create, enable/disable, a tick's `lastSlotAt` advance) starts from
   *  its own `readSchedule` in the same request, and a schedule is
   *  configuration plus a watermark, not a mutex over live work. */
  writeSchedule(schedule: Schedule): Promise<void>;
  /** Newest first -- `scheduleId` is a ULID, so descending lexicographic
   *  order on it is descending creation order (matches
   *  `OrchestratorStore.listNativeTasks`). */
  listSchedules(limit?: number): Promise<Schedule[]>;
  listEnabledSchedules(): Promise<Schedule[]>;
}
