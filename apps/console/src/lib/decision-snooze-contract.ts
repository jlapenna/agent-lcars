import { z } from 'zod';

import { MAX_DECISION_SNOOZES } from './decision-snooze-values';

export {
  LEGACY_MUTE_STORAGE_KEY,
  MAX_DECISION_SNOOZES,
  parseLegacyMutes,
  SNOOZE_DURATIONS,
} from './decision-snooze-values';

export const decisionSnoozeAnchorSchema = z.strictObject({
  anchor: z
    .string()
    .max(256)
    .regex(
      /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*|work:[0-9A-Z]{26})$/,
    ),
  signature: z.string().min(1).max(1024),
});
export const snoozeDecisionSchema = decisionSnoozeAnchorSchema.extend({
  minutes: z.union([
    z.literal(15),
    z.literal(60),
    z.literal(1440),
    z.literal(10080),
  ]),
});
export const importDecisionSnoozesSchema = z
  .array(decisionSnoozeAnchorSchema)
  .max(MAX_DECISION_SNOOZES);
export const decisionSnoozeSchema = z.strictObject({
  signature: z.string().min(1).max(1024),
  snoozedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type DecisionSnooze = z.infer<typeof decisionSnoozeSchema>;
export type DecisionSnoozes = Record<string, DecisionSnooze>;
export type SnoozeDecisionInput = z.infer<typeof snoozeDecisionSchema>;
export type DecisionSnoozeAnchor = z.infer<typeof decisionSnoozeAnchorSchema>;
export type DecisionSnoozeResult =
  { ok: true; entries: DecisionSnoozes } | { ok: false; error: string };

export function activeDecisionSnoozes(
  raw: unknown,
  now: number,
): DecisionSnoozes {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).flatMap(([anchor, value]) => {
      const entry = decisionSnoozeSchema.safeParse(value);
      return decisionSnoozeAnchorSchema.shape.anchor.safeParse(anchor)
        .success &&
        entry.success &&
        Date.parse(entry.data.expiresAt) > now
        ? [[anchor, entry.data]]
        : [];
    }),
  );
}
