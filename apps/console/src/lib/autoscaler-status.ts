import 'server-only';

import { logger } from '@agent-lcars/logging';
import {
  forClient,
  getAgentTelemetryReaderFirestore,
} from '@agent-lcars/telemetry/server';

import { RUNNER_STATUS_STALENESS_MS } from './runner-status-contract';

const RUNNER_STATUS_COLLECTION = 'runner-status';

export interface AutoscalerRunnerStatus {
  name: string;
  host: string;
  state: 'idle' | 'busy';
  jobId?: string;
}

export interface AutoscalerScaleSetStatus {
  schemaVersion: 1;
  scaleSet: string;
  registration: string;
  registrationUrl?: string;
  queuedJobs: number;
  minRunners: number;
  maxRunners: number;
  draining: boolean;
  runners: AutoscalerRunnerStatus[];
  updatedAt: string;
}

/** Generic direct-executor health, intentionally separate from v1 scale-set
 * capacity. Queue lifecycle counts belong to orchestrator Run records, not
 * this host telemetry projection. */
export interface QueueExecutorStatus {
  schemaVersion: 2;
  kind: 'queue-executor';
  executor: 'queue';
  ready: boolean;
  draining: boolean;
  activeRuns?: number;
  maxConcurrent: number;
  updatedAt: string;
}

export interface AutoscalerStatusResult {
  statuses: AutoscalerScaleSetStatus[];
  lanes?: ArcLaneStatus[];
  queueExecutor?: QueueExecutorStatus;
  warnings: string[];
}

export interface ArcLaneStatus {
  schemaVersion: 3;
  kind: 'arc-lane';
  lane: string;
  registrationUrl: string;
  assignedJobs: number;
  runningJobs: number;
  pendingJobs: number;
  idleRunners: number;
  registeredRunners: number;
  desiredRunners: number;
  minRunners: number;
  maxRunners: number;
  updatedAt: string;
}

function parseArcLane(value: unknown): ArcLaneStatus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const status = value as Record<string, unknown>;
  const counts = [
    'assignedJobs',
    'runningJobs',
    'pendingJobs',
    'idleRunners',
    'registeredRunners',
    'desiredRunners',
    'minRunners',
    'maxRunners',
  ] as const;
  if (
    status['schemaVersion'] !== 3 ||
    status['kind'] !== 'arc-lane' ||
    typeof status['lane'] !== 'string' ||
    typeof status['registrationUrl'] !== 'string' ||
    !/^https?:\/\//.test(status['registrationUrl']) ||
    typeof status['updatedAt'] !== 'string' ||
    counts.some(
      (key) =>
        !Number.isSafeInteger(status[key]) || (status[key] as number) < 0,
    )
  )
    return undefined;
  return {
    schemaVersion: 3,
    kind: 'arc-lane',
    lane: status['lane'],
    registrationUrl: status['registrationUrl'],
    assignedJobs: status['assignedJobs'] as number,
    runningJobs: status['runningJobs'] as number,
    pendingJobs: status['pendingJobs'] as number,
    idleRunners: status['idleRunners'] as number,
    registeredRunners: status['registeredRunners'] as number,
    desiredRunners: status['desiredRunners'] as number,
    minRunners: status['minRunners'] as number,
    maxRunners: status['maxRunners'] as number,
    updatedAt: status['updatedAt'],
  };
}

function parseRunner(value: unknown): AutoscalerRunnerStatus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const runner = value as Record<string, unknown>;
  if (
    typeof runner['name'] === 'string' &&
    typeof runner['host'] === 'string' &&
    (runner['state'] === 'idle' || runner['state'] === 'busy') &&
    (runner['jobId'] === undefined || typeof runner['jobId'] === 'string')
  ) {
    // This is the server-to-client transport boundary. Do not return the
    // Firestore value (or a spread of it): Firestore can add Timestamp and
    // other class instances which React Server Components cannot serialize.
    return {
      name: runner['name'],
      host: runner['host'],
      state: runner['state'],
      ...(typeof runner['jobId'] === 'string'
        ? { jobId: runner['jobId'] }
        : {}),
    };
  }
  return undefined;
}

function parseRunners(value: unknown): AutoscalerRunnerStatus[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const runners: AutoscalerRunnerStatus[] = [];
  for (const candidate of value) {
    const runner = parseRunner(candidate);
    if (!runner) return undefined;
    runners.push(runner);
  }
  return runners;
}

function parseStatus(value: unknown): AutoscalerScaleSetStatus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const status = value as Record<string, unknown>;
  const runners = parseRunners(status['runners']);
  if (
    status['schemaVersion'] !== 1 ||
    typeof status['scaleSet'] !== 'string' ||
    typeof status['registration'] !== 'string' ||
    (status['registrationUrl'] !== undefined &&
      typeof status['registrationUrl'] !== 'string') ||
    typeof status['queuedJobs'] !== 'number' ||
    typeof status['minRunners'] !== 'number' ||
    typeof status['maxRunners'] !== 'number' ||
    typeof status['draining'] !== 'boolean' ||
    typeof status['updatedAt'] !== 'string' ||
    !runners
  ) {
    return undefined;
  }
  // Keep this server-to-client mapping explicit: only primitive,
  // client-contract fields may leave the server. In
  // particular, `expireAt` is a Firestore Timestamp used only for server-side
  // staleness and must never enter a Client Component prop.
  return {
    schemaVersion: 1,
    scaleSet: status['scaleSet'],
    registration: status['registration'],
    ...(typeof status['registrationUrl'] === 'string'
      ? { registrationUrl: status['registrationUrl'] }
      : {}),
    queuedJobs: status['queuedJobs'],
    minRunners: status['minRunners'],
    maxRunners: status['maxRunners'],
    draining: status['draining'],
    runners,
    updatedAt: status['updatedAt'],
  };
}

function parseQueueExecutor(value: unknown): QueueExecutorStatus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const status = value as Record<string, unknown>;
  if (
    status['schemaVersion'] !== 2 ||
    status['kind'] !== 'queue-executor' ||
    status['executor'] !== 'queue' ||
    typeof status['ready'] !== 'boolean' ||
    typeof status['draining'] !== 'boolean' ||
    (status['activeRuns'] !== undefined &&
      typeof status['activeRuns'] !== 'number') ||
    typeof status['maxConcurrent'] !== 'number' ||
    typeof status['updatedAt'] !== 'string'
  ) {
    return undefined;
  }
  return {
    schemaVersion: 2,
    kind: 'queue-executor',
    executor: 'queue',
    ready: status['ready'],
    draining: status['draining'],
    ...(typeof status['activeRuns'] === 'number'
      ? { activeRuns: status['activeRuns'] }
      : {}),
    maxConcurrent: status['maxConcurrent'],
    updatedAt: status['updatedAt'],
  };
}

function isFresh(updatedAt: string, now: number): boolean {
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) && now - parsed <= RUNNER_STATUS_STALENESS_MS;
}

/**
 * Projects raw `runner-status` documents into the client contract: only
 * schema-valid, fresh documents, and only primitive fields (never a
 * Firestore `Timestamp`), so the result can cross the server/client boundary
 * as a prop or as JSON.
 */
export function projectAutoscalerStatuses(
  records: readonly unknown[],
  now = Date.now(),
): AutoscalerStatusResult {
  const statuses = records
    .map((record) => parseStatus(record))
    .filter(
      (status): status is AutoscalerScaleSetStatus =>
        status !== undefined && isFresh(status.updatedAt, now),
    )
    .sort((a, b) => a.scaleSet.localeCompare(b.scaleSet));
  const queueExecutor = records
    .map((record) => parseQueueExecutor(record))
    .find(
      (status): status is QueueExecutorStatus =>
        status !== undefined && isFresh(status.updatedAt, now),
    );
  const laneRecords = records
    .map(parseArcLane)
    .filter((status): status is ArcLaneStatus => status !== undefined);
  const lanes = laneRecords
    .filter((status) => isFresh(status.updatedAt, now))
    .sort((a, b) => a.lane.localeCompare(b.lane));
  return {
    statuses,
    lanes,
    ...(queueExecutor === undefined ? {} : { queueExecutor }),
    warnings:
      laneRecords.length > lanes.length ? ['ARC lane status is stale.'] : [],
  };
}

const UNAVAILABLE: AutoscalerStatusResult = {
  statuses: [],
  warnings: ['Runner autoscaler status unavailable (telemetry store failed).'],
};

/**
 * Reads the autoscaler's bounded current-state projection once, for the
 * server-rendered first paint. Deliberately uncached and separate from the
 * dashboard's GitHub fan-out; later changes arrive through
 * {@link subscribeAutoscalerStatuses}.
 */
export async function getAutoscalerStatuses(): Promise<AutoscalerStatusResult> {
  try {
    const firestore = await getAgentTelemetryReaderFirestore();
    const snapshot = await firestore.collection(RUNNER_STATUS_COLLECTION).get();
    return projectAutoscalerStatuses(
      snapshot.docs.map((doc) => forClient(doc.data())),
    );
  } catch (error) {
    logger.error('agent-lcars: failed to list autoscaler status:', error);
    return UNAVAILABLE;
  }
}

/**
 * Listens to the `runner-status` collection and calls `onResult` with a
 * fresh projection for the initial snapshot and for every change the
 * producer writes. The producer writes only on change or heartbeat, so this
 * replaces the browser's former fixed-interval poll. A failure to start or a
 * listener error is reported once as the unavailable result and ends the
 * subscription; the caller decides when to reconnect. Never rejects. Returns
 * the unsubscribe function.
 */
export async function subscribeAutoscalerStatuses(
  onResult: (result: AutoscalerStatusResult) => void,
): Promise<() => void> {
  let firestore: Awaited<ReturnType<typeof getAgentTelemetryReaderFirestore>>;
  try {
    firestore = await getAgentTelemetryReaderFirestore();
  } catch (error) {
    logger.error('agent-lcars: autoscaler status listener failed:', error);
    onResult(UNAVAILABLE);
    return () => undefined;
  }
  return firestore.collection(RUNNER_STATUS_COLLECTION).onSnapshot(
    (snapshot) => {
      onResult(
        projectAutoscalerStatuses(
          snapshot.docs.map((doc) => forClient(doc.data())),
        ),
      );
    },
    (error) => {
      logger.error('agent-lcars: autoscaler status listener failed:', error);
      onResult(UNAVAILABLE);
    },
  );
}
