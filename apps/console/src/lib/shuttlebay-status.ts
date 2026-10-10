import 'server-only';

import { logger } from '@agent-lcars/logging';
import type { QueueAdmissionStatus } from '@agent-lcars/orchestrator';
import { PIPELINES } from '@agent-lcars/work';

import {
  type AutoscalerStatusResult,
  getAutoscalerStatuses,
  subscribeAutoscalerStatuses,
} from './autoscaler-status';
import { createOrchestratorRuntime } from './orchestrator-runtime';

const READ_DEADLINE_MS = 5000;
const ADMISSION_REFRESH_MS = 30_000;
const ADMISSION_UNAVAILABLE = 'Provider queue and cooldown status unavailable.';
let admissionRead: Promise<QueueAdmissionStatus> | undefined;
let telemetryRead: Promise<AutoscalerStatusResult> | undefined;

/** A response deadline cannot cancel a datastore request. Keep ownership of
 * the underlying promise until it settles so retries/streams cannot multiply
 * hung reads. Successful results are not cached. */
function readAdmission(): Promise<QueueAdmissionStatus> {
  if (admissionRead !== undefined) return admissionRead;
  const read = createOrchestratorRuntime().store.readQueueAdmissionStatus({
    pipelines: PIPELINES,
    now: new Date().toISOString(),
  });
  admissionRead = read;
  const clear = () => {
    if (admissionRead === read) admissionRead = undefined;
  };
  void read.then(clear, clear);
  return read;
}

function readTelemetry(): Promise<AutoscalerStatusResult> {
  if (telemetryRead !== undefined) return telemetryRead;
  const read = getAutoscalerStatuses();
  telemetryRead = read;
  const clear = () => {
    if (telemetryRead === read) telemetryRead = undefined;
  };
  void read.then(clear, clear);
  return read;
}

async function withinDeadline<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Shuttlebay evidence read timed out')),
          READ_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Admission and host evidence fail independently; neither failure is zero. */
export async function withProviderAdmission(
  result: AutoscalerStatusResult,
): Promise<AutoscalerStatusResult> {
  try {
    return {
      ...result,
      providerAdmission: await withinDeadline(readAdmission()),
    };
  } catch (error) {
    logger.error('agent-lcars: provider admission unavailable:', error);
    return {
      ...result,
      providerAdmission: undefined,
      warnings: [...result.warnings, ADMISSION_UNAVAILABLE],
    };
  }
}

async function boundedTelemetry(): Promise<AutoscalerStatusResult> {
  try {
    return await withinDeadline(readTelemetry());
  } catch (error) {
    logger.error('agent-lcars: runner telemetry unavailable:', error);
    return {
      warnings: [
        'Runner autoscaler status unavailable (telemetry read timed out or failed).',
      ],
    };
  }
}

export async function getShuttlebayStatus(): Promise<AutoscalerStatusResult> {
  const [telemetry, provider] = await Promise.all([
    boundedTelemetry(),
    withProviderAdmission({ warnings: [] }),
  ]);
  return {
    ...telemetry,
    providerAdmission: provider.providerAdmission,
    warnings: [...telemetry.warnings, ...provider.warnings],
  };
}

/** Host updates are emitted immediately. An independent bounded admission
 * refresh emits against the latest host snapshot, even if host updates keep
 * arriving or stop altogether. The two sources cannot starve each other. */
export async function subscribeShuttlebayStatus(
  onResult: (result: AutoscalerStatusResult) => void,
): Promise<() => void> {
  let closed = false;
  let refreshing = false;
  let latest: AutoscalerStatusResult = {
    warnings: ['Runner status awaiting first snapshot.'],
  };
  let admission: QueueAdmissionStatus | undefined;
  let admissionUnavailable = true;
  const emit = () => {
    if (!closed)
      onResult({
        ...latest,
        providerAdmission: admission,
        warnings: admissionUnavailable
          ? [...latest.warnings, ADMISSION_UNAVAILABLE]
          : latest.warnings,
      });
  };
  const refresh = async () => {
    if (closed || refreshing) return;
    refreshing = true;
    try {
      const result = await withProviderAdmission({
        warnings: [],
      });
      admission = result.providerAdmission;
      admissionUnavailable = admission === undefined;
      emit();
    } finally {
      refreshing = false;
    }
  };
  const unsubscribe = await subscribeAutoscalerStatuses((result) => {
    latest = result;
    emit();
    void refresh();
  });
  void refresh();
  const timer = setInterval(() => {
    void refresh();
  }, ADMISSION_REFRESH_MS);
  return () => {
    closed = true;
    clearInterval(timer);
    unsubscribe();
  };
}
