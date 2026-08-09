import 'server-only';

import { getAgentTelemetryReaderFirestore } from '@agent-lcars/telemetry/server';

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
  queuedJobs: number;
  minRunners: number;
  maxRunners: number;
  draining: boolean;
  runners: AutoscalerRunnerStatus[];
  updatedAt: string;
}

export interface AutoscalerStatusResult {
  statuses: AutoscalerScaleSetStatus[];
  warnings: string[];
}

function isRunner(value: unknown): value is AutoscalerRunnerStatus {
  if (!value || typeof value !== 'object') return false;
  const runner = value as Record<string, unknown>;
  return (
    typeof runner['name'] === 'string' &&
    typeof runner['host'] === 'string' &&
    (runner['state'] === 'idle' || runner['state'] === 'busy') &&
    (runner['jobId'] === undefined || typeof runner['jobId'] === 'string')
  );
}

function parseStatus(value: unknown): AutoscalerScaleSetStatus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const status = value as Record<string, unknown>;
  if (
    status['schemaVersion'] !== 1 ||
    typeof status['scaleSet'] !== 'string' ||
    typeof status['registration'] !== 'string' ||
    typeof status['queuedJobs'] !== 'number' ||
    typeof status['minRunners'] !== 'number' ||
    typeof status['maxRunners'] !== 'number' ||
    typeof status['draining'] !== 'boolean' ||
    typeof status['updatedAt'] !== 'string' ||
    !Array.isArray(status['runners']) ||
    !status['runners'].every(isRunner)
  ) {
    return undefined;
  }
  return status as unknown as AutoscalerScaleSetStatus;
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
    const statuses = snapshot.docs
      .map((doc) => parseStatus(doc.data()))
      .filter((status): status is AutoscalerScaleSetStatus => {
        if (!status) return false;
        const updatedAt = Date.parse(status.updatedAt);
        return (
          Number.isFinite(updatedAt) &&
          now - updatedAt <= RUNNER_STATUS_STALENESS_MS
        );
      })
      .sort((a, b) => a.scaleSet.localeCompare(b.scaleSet));
    return { statuses, warnings: [] };
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
