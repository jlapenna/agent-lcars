export const SNOOZE_DURATIONS = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 1440, label: '24 hours' },
  { minutes: 10080, label: '7 days' },
] as const;
export const MAX_DECISION_SNOOZES = 500;
export const LEGACY_MUTE_STORAGE_KEY = 'agent-lcars:muted-queue-items';

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
