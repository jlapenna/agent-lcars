import 'server-only';

import { logger } from '@agent-lcars/logging';
import type { QueueAdmissionStatus } from '@agent-lcars/orchestrator';
import {
  forClient,
  getAgentTelemetryReaderFirestore,
} from '@agent-lcars/telemetry/server';

import { type HistogramWindow, parseHistogramWindow } from './histogram-window';
import {
  ARC_UNBOUNDED_MAX_RUNNERS,
  RUNNER_STATUS_STALENESS_MS,
} from './runner-status-contract';

const RUNNER_STATUS_COLLECTION = 'runner-status';

/** Generic direct-executor health, separate from ARC GitHub runner capacity.
 * Queue lifecycle counts belong to orchestrator Run records, not
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
  claims?: QueueClaimWindow;
  /** The executor's own Work API response times, when known. */
  workApiLatency?: HistogramWindow;
}

export interface QueueClaimWindow {
  claude: number;
  codex: number;
  opencode: number;
  windowStart: string;
  windowEnd: string;
}

export interface AutoscalerStatusResult {
  lanes?: ArcLaneStatus[];
  /** A configured lane is missing/stale/invalid, or its inventory is unknown. */
  lanesIncomplete?: boolean;
  queueExecutor?: QueueExecutorStatus;
  providerAdmission?: QueueAdmissionStatus;
  warnings: string[];
}

export interface ArcLaneStatus {
  schemaVersion: 3;
  kind: 'arc-lane';
  lane: string;
  /** Authoritative deployment inventory, repeated by each surviving producer. */
  expectedLanes?: string;
  registrationUrl: string;
  assignedJobs: number;
  runningJobs: number;
  pendingJobs: number;
  idleRunners: number;
  registeredRunners: number;
  desiredRunners: number;
  minRunners: number;
  /** Absent when the scale set configures no maximum. */
  maxRunners?: number;
  /** The listener's last 30 minutes of job-startup latency, when known. */
  jobStartup?: HistogramWindow;
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
  const jobStartup = parseHistogramWindow(status['jobStartup']);
  return {
    schemaVersion: 3,
    kind: 'arc-lane',
    lane: status['lane'],
    ...(typeof status['expectedLanes'] === 'string'
      ? { expectedLanes: status['expectedLanes'] }
      : {}),
    registrationUrl: status['registrationUrl'],
    assignedJobs: status['assignedJobs'] as number,
    runningJobs: status['runningJobs'] as number,
    pendingJobs: status['pendingJobs'] as number,
    idleRunners: status['idleRunners'] as number,
    registeredRunners: status['registeredRunners'] as number,
    desiredRunners: status['desiredRunners'] as number,
    minRunners: status['minRunners'] as number,
    ...((status['maxRunners'] as number) < ARC_UNBOUNDED_MAX_RUNNERS
      ? { maxRunners: status['maxRunners'] as number }
      : {}),
    ...(jobStartup === undefined ? {} : { jobStartup }),
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
  const workApiLatency = parseHistogramWindow(status['workApiLatency']);
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
    ...(parseClaimWindow(status['claims'], status['updatedAt']) === undefined
      ? {}
      : { claims: parseClaimWindow(status['claims'], status['updatedAt']) }),
    ...(workApiLatency === undefined ? {} : { workApiLatency }),
  };
}

function parseClaimWindow(
  value: unknown,
  updatedAt: string,
): QueueClaimWindow | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const start = record['windowStart'];
  const end = record['windowEnd'];
  if (typeof start !== 'string' || typeof end !== 'string') return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    startMs >= endMs ||
    endMs - startMs > 15 * 60_000 ||
    endMs > Date.parse(updatedAt) ||
    Date.parse(updatedAt) - endMs > RUNNER_STATUS_STALENESS_MS
  )
    return undefined;
  if (
    ['claude', 'codex', 'opencode'].some(
      (key) =>
        !Number.isSafeInteger(record[key]) || (record[key] as number) < 0,
    )
  )
    return undefined;
  return {
    claude: record['claude'] as number,
    codex: record['codex'] as number,
    opencode: record['opencode'] as number,
    windowStart: start,
    windowEnd: end,
  };
}

function isFresh(updatedAt: string, now: number): boolean {
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) && now - parsed <= RUNNER_STATUS_STALENESS_MS;
}

function isLaneName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)
  );
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
  const arcRecords = records.filter(
    (record): record is Record<string, unknown> =>
      record !== null &&
      typeof record === 'object' &&
      'kind' in record &&
      record.kind === 'arc-lane',
  );
  // Do not infer configured capacity from the documents that happened to
  // survive. Every fresh lane must attest the same bounded inventory, with
  // exactly one fresh record per expected lane. Old producers fail closed.
  const inventory = lanes[0]?.expectedLanes;
  const expected = inventory?.split(',') ?? [];
  const inventoryValid =
    expected.length > 0 &&
    expected.length <= 64 &&
    expected.every(isLaneName) &&
    new Set(expected).size === expected.length &&
    lanes.every((lane) => lane.expectedLanes === inventory);
  // Firestore TTL deletion is asynchronous. Only a valid unanimous current
  // inventory can prove that an expired, identifiable snapshot is retired.
  // Fresh unexpected producers and unidentifiable evidence still fail closed.
  const retired = (record: ArcLaneStatus | Record<string, unknown>) =>
    inventoryValid &&
    isLaneName(record['lane']) &&
    !expected.includes(record['lane']) &&
    typeof record['updatedAt'] === 'string' &&
    Number.isFinite(Date.parse(record['updatedAt'])) &&
    !isFresh(record['updatedAt'], now);
  const stale = laneRecords.some(
    (record) => !isFresh(record.updatedAt, now) && !retired(record),
  );
  const invalid = arcRecords.some(
    (record) => !retired(record) && parseArcLane(record) === undefined,
  );
  const missing =
    inventoryValid &&
    (expected.length !== lanes.length ||
      expected.some((name) => !lanes.some((lane) => lane.lane === name)));
  const inventoryUnknown = lanes.length > 0 && !inventoryValid;
  return {
    lanes,
    ...(stale || invalid || missing || inventoryUnknown
      ? { lanesIncomplete: true }
      : {}),
    ...(queueExecutor === undefined ? {} : { queueExecutor }),
    warnings: [
      ...(stale ? ['ARC lane status is stale.'] : []),
      ...(invalid ? ['ARC lane status is invalid.'] : []),
      ...(inventoryUnknown
        ? ['ARC lane inventory is unavailable or inconsistent.']
        : []),
      ...(missing ? ['Configured ARC lane status is missing.'] : []),
    ],
  };
}

const UNAVAILABLE: AutoscalerStatusResult = {
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
