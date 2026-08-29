import 'server-only';

import {
  forClient,
  getAgentTelemetryReaderFirestore,
} from '@agent-lcars/telemetry/server';

const RUNNER_STATUS_COLLECTION = 'runner-status';
export const RUNNER_STATUS_STALENESS_MS = 30_000;

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
  queueExecutor?: QueueExecutorStatus;
  warnings: string[];
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

/**
 * Reads the autoscaler's bounded current-state projection. This is deliberately
 * uncached: status is polled separately by the small client panel so refreshing
 * it never repeats the dashboard's expensive GitHub API fan-out.
 */
export async function getAutoscalerStatuses(): Promise<AutoscalerStatusResult> {
  try {
    const firestore = await getAgentTelemetryReaderFirestore();
    const snapshot = await firestore.collection(RUNNER_STATUS_COLLECTION).get();
    const now = Date.now();
    const records = snapshot.docs.map((doc) => forClient(doc.data()));
    const statuses = records
      .map((record) => parseStatus(record))
      .filter((status): status is AutoscalerScaleSetStatus => {
        if (!status) return false;
        const updatedAt = Date.parse(status.updatedAt);
        return (
          Number.isFinite(updatedAt) &&
          now - updatedAt <= RUNNER_STATUS_STALENESS_MS
        );
      })
      .sort((a, b) => a.scaleSet.localeCompare(b.scaleSet));
    const queueExecutor = records
      .map((record) => parseQueueExecutor(record))
      .find((status) => {
        if (!status) return false;
        const updatedAt = Date.parse(status.updatedAt);
        return (
          Number.isFinite(updatedAt) &&
          now - updatedAt <= RUNNER_STATUS_STALENESS_MS
        );
      });
    return {
      statuses,
      ...(queueExecutor === undefined ? {} : { queueExecutor }),
      warnings: [],
    };
  } catch (error) {
    console.error('agent-lcars: failed to list autoscaler status:', error);
    return {
      statuses: [],
      warnings: [
        'Runner autoscaler status unavailable (telemetry store failed).',
      ],
    };
  }
}
