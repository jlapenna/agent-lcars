/** Only identifiers and decision generations cross the notification boundary;
 * titles, questions, bodies and transcripts never enter OS previews. */
export interface NotificationDecision {
  id: string;
  generation: string;
}

export interface NotificationSourceTimes {
  queue: number;
  activity: number;
  native: number;
}

export interface InboxNotificationSnapshot {
  principalId: string;
  observedAt: number;
  available: boolean;
  sourceTimes: NotificationSourceTimes;
  decisions: NotificationDecision[];
}

export const NOTIFICATION_RATE_MS = 60_000;
export const NOTIFICATION_FRESH_MS = 60_000;
export const NOTIFICATION_MAX_DECISIONS = 1_000;
export const NOTIFICATION_SCOPE = '/inbox/';
export const NOTIFICATION_WORKER = '/inbox-notifications-sw.js';

export interface InboxNotificationState {
  version: 1;
  enabled: boolean;
  active: NotificationDecision[] | null;
  pending: NotificationDecision[];
  observedAt: number;
  lastSentAt: number;
  sourceTimes: NotificationSourceTimes;
}

export function notificationStorageKey(principalId: string): string {
  return `agent-lcars:inbox-notifications:v1:${encodeURIComponent(principalId)}`;
}

export function emptyNotificationState(): InboxNotificationState {
  return {
    version: 1,
    enabled: false,
    active: null,
    pending: [],
    observedAt: 0,
    lastSentAt: 0,
    sourceTimes: { queue: 0, activity: 0, native: 0 },
  };
}

function decisionsValid(value: unknown): value is NotificationDecision[] {
  return (
    Array.isArray(value) &&
    value.length <= NOTIFICATION_MAX_DECISIONS &&
    value.every(
      (d: unknown) =>
        d !== null &&
        typeof d === 'object' &&
        'id' in d &&
        typeof d.id === 'string' &&
        d.id.length > 0 &&
        d.id.length <= 200 &&
        'generation' in d &&
        typeof d.generation === 'string' &&
        d.generation.length <= 400,
    ) &&
    new Set(value.map((d: NotificationDecision) => d.id)).size === value.length
  );
}

function sourceTimesValid(value: unknown): value is NotificationSourceTimes {
  return (
    value !== null &&
    typeof value === 'object' &&
    ['queue', 'activity', 'native'].every((key) => {
      const time = (value as Record<string, unknown>)[key];
      return typeof time === 'number' && Number.isFinite(time) && time >= 0;
    })
  );
}

/** Corrupt or blocked storage is unavailable, not an empty dedupe ledger. */
export function parseNotificationState(
  raw: string | null,
): InboxNotificationState {
  if (raw === null) return emptyNotificationState();
  const value: unknown = JSON.parse(raw);
  if (
    value === null ||
    typeof value !== 'object' ||
    !('sourceTimes' in value) ||
    !sourceTimesValid(value.sourceTimes) ||
    !('version' in value) ||
    value.version !== 1 ||
    !('enabled' in value) ||
    typeof value.enabled !== 'boolean' ||
    !('active' in value) ||
    (value.active !== null && !decisionsValid(value.active)) ||
    !('pending' in value) ||
    !decisionsValid(value.pending) ||
    !('observedAt' in value) ||
    typeof value.observedAt !== 'number' ||
    !Number.isFinite(value.observedAt) ||
    value.observedAt < 0 ||
    !('lastSentAt' in value) ||
    typeof value.lastSentAt !== 'number' ||
    !Number.isFinite(value.lastSentAt) ||
    value.lastSentAt < 0
  )
    throw new Error('Notification preferences unavailable');
  return value as InboxNotificationState;
}

export function notificationSnapshotFresh(
  snapshot: InboxNotificationSnapshot,
  now: number,
): boolean {
  return (
    snapshot.available &&
    sourceTimesValid(snapshot.sourceTimes) &&
    Object.values(snapshot.sourceTimes).every(
      (time: number) => time <= now && now - time < NOTIFICATION_FRESH_MS,
    ) &&
    decisionsValid(snapshot.decisions) &&
    Number.isFinite(snapshot.observedAt) &&
    snapshot.observedAt <= now &&
    now - snapshot.observedAt < NOTIFICATION_FRESH_MS
  );
}

/** A complete fresh snapshot observes disappearance/reopening. Partial,
 * stale and older snapshots cannot erase the active set or invent reopenings.
 * First observation is a quiet baseline, including on explicit re-enable. */
export function advanceNotificationState(
  state: InboxNotificationState,
  snapshot: InboxNotificationSnapshot,
  now: number,
): InboxNotificationState {
  if (
    !state.enabled ||
    !notificationSnapshotFresh(snapshot, now) ||
    Object.keys(state.sourceTimes).some(
      (key) =>
        snapshot.sourceTimes[key as keyof NotificationSourceTimes] <
        state.sourceTimes[key as keyof NotificationSourceTimes],
    ) ||
    Object.keys(state.sourceTimes).every(
      (key) =>
        snapshot.sourceTimes[key as keyof NotificationSourceTimes] ===
        state.sourceTimes[key as keyof NotificationSourceTimes],
    )
  )
    return state;
  const active = new Map(snapshot.decisions.map((d) => [d.id, d.generation]));
  const previous = new Map(state.active?.map((d) => [d.id, d.generation]));
  const pending = new Map(
    state.pending
      .filter((d) => active.get(d.id) === d.generation)
      .map((d) => [d.id, d]),
  );
  if (state.active !== null) {
    for (const decision of snapshot.decisions) {
      if (previous.get(decision.id) !== decision.generation)
        pending.set(decision.id, decision);
    }
  }
  return {
    ...state,
    active: snapshot.decisions,
    pending: [...pending.values()],
    observedAt: snapshot.observedAt,
    sourceTimes: snapshot.sourceTimes,
  };
}

export function notificationHref(
  decisions: readonly NotificationDecision[],
): string {
  return decisions.length === 1
    ? `/inbox?${new URLSearchParams({ item: decisions[0].id })}`
    : '/inbox';
}
