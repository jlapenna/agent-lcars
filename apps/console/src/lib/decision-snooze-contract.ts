import { z } from 'zod';

export const SNOOZE_DURATIONS = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 1440, label: '24 hours' },
  { minutes: 10080, label: '7 days' },
] as const;
export const MAX_DECISION_SNOOZES = 500;
export const LEGACY_MUTE_STORAGE_KEY = 'agent-lcars:muted-queue-items';

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

/** Local mutes predate authenticated ownership. Import is explicit, finite,
 * and only offered for decisions whose current signature still matches. */
export function parseLegacyMutes(
  raw: string | null,
): Record<string, string | null> {
  try {
    const value: unknown = raw ? JSON.parse(raw) : undefined;
    if (Array.isArray(value))
      return Object.fromEntries(
        value
          .filter((key): key is string => typeof key === 'string')
          .map((key) => [key, null]),
      );
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).filter(
          ([, signature]) =>
            signature === null || typeof signature === 'string',
        ),
      );
  } catch {
    /* Corrupt storage cannot hide a decision. */
  }
  return {};
}
