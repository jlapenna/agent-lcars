import 'server-only';

import { createHash } from 'node:crypto';

import {
  CLAW_ONCALL_INVESTIGATE_OPERATION,
  clawInvestigateInputSchema,
} from '@agent-lcars/dispatch-contracts';
import { isRefusal, workRevisionSchema } from '@agent-lcars/orchestrator';
import {
  clawWorkSpecSchema,
  storedWorkPayloadSchema,
  ulid,
  WORK_TITLE_MAX,
} from '@agent-lcars/work';

import {
  ClawAdmissionConflict,
  type ClawAdmissionRuntime,
} from './claw-investigate-work';

export const CLAW_ONCALL_PIPELINE = 'claw-oncall' as const;

/** Per admitting principal, exactly like `admitInvestigation`: one gate's
 *  group key never resolves to another principal's Work. */
function oncallSourceKey(principal: string, groupKey: string): string {
  return `${CLAW_ONCALL_INVESTIGATE_OPERATION}:${principal}:${groupKey}`;
}

function oncallText(groupKey: string): { title: string; description: string } {
  const title = `Oncall alert group ${groupKey}`;
  return {
    title:
      title.length <= WORK_TITLE_MAX
        ? title
        : `${title.slice(0, WORK_TITLE_MAX - 1)}…`,
    description: `claw/oncall investigation of Alertmanager group ${groupKey}. Each fingerprint set is one revision; its alert text is that revision's input.`,
  };
}

/** Stored Work is compatible only when this principal admitted it for this
 *  group under `claw-oncall`. Immutable once stored. */
function isOwnOncallWork(
  stored: unknown,
  principal: string,
  groupKey: string,
): boolean {
  const parsed = storedWorkPayloadSchema.safeParse(stored);
  if (!parsed.success) return false;
  if (parsed.data.origin?.principal !== principal) return false;
  if (parsed.data.origin.channel !== 'alertmanager') return false;
  const claw = clawWorkSpecSchema.safeParse(parsed.data.spec);
  return (
    claw.success &&
    claw.data.pipeline === CLAW_ONCALL_PIPELINE &&
    claw.data.operation === CLAW_ONCALL_INVESTIGATE_OPERATION &&
    claw.data.sourceKey === groupKey
  );
}

/** The fingerprint set (design: `sourceRevision: <verified fingerprints>`),
 *  deduplicated and order-independent, plus the firing episode, so a group
 *  that resolves and re-fires with the same fingerprints is a new round. */
export function oncallRevisionKey(
  fingerprints: readonly string[],
  episode?: string,
): string {
  const sorted = [...new Set(fingerprints)].sort();
  return createHash('sha256')
    .update(JSON.stringify({ fingerprints: sorted, episode: episode ?? null }))
    .digest('hex');
}

/**
 * Admits one `oncall-investigate:v1` round for a firing Alertmanager group.
 *
 * Origin channel `alertmanager` has no thread: the outcome is persisted, and
 * `oncall-alert-gate` reads it back through `GET /items/{id}` to acknowledge
 * the page on the first attempt heartbeat and to post the report to Slack
 * (the Console cannot reach that LAN receiver). Rounds are `urgent` so they
 * claim ahead of investigator work in the shared zone. The
 * same fingerprint set and episode are the same round even when the
 * rendered alert text differs (annotations re-render on every
 * notification); a new set, or a re-fire after resolution (a new episode),
 * supersedes a queued round and waits behind a claimed one.
 */
export async function admitOncallAlert(
  runtime: ClawAdmissionRuntime,
  request: {
    groupKey: string;
    fingerprints: readonly string[];
    episode?: string;
    question: string;
    principal: string;
  },
): Promise<{ workId: string; duplicate: boolean }> {
  const input = clawInvestigateInputSchema.parse({
    question: request.question,
  });
  const workId = await runtime.store.resolveSourceWorkId(
    oncallSourceKey(request.principal, request.groupKey),
    ulid(),
  );
  const revision = workRevisionSchema.parse({
    key: oncallRevisionKey(request.fingerprints, request.episode),
    input: { operation: CLAW_ONCALL_INVESTIGATE_OPERATION, ...input },
  });
  const spec = clawWorkSpecSchema.parse({
    ...oncallText(request.groupKey),
    pipeline: CLAW_ONCALL_PIPELINE,
    priority: 'urgent',
    operation: CLAW_ONCALL_INVESTIGATE_OPERATION,
    sourceKey: request.groupKey,
  });
  const outcome = await runtime.orchestrator.request({
    taskId: { workId },
    requestId: revision.key,
    pipeline: spec.pipeline,
    priority: spec.priority,
    params: { mode: 'claw' },
    work: {
      origin: { principal: request.principal, channel: 'alertmanager' },
      spec,
    },
    sourceRevision: revision,
    isStoredWorkCompatible: (stored) =>
      isOwnOncallWork(stored, request.principal, request.groupKey),
  });
  if (isRefusal(outcome)) {
    if (outcome.reason === 'duplicate-request')
      return { workId, duplicate: true };
    if (outcome.reason === 'work-spec-mismatch') {
      // The orchestrator also reports a reused revision key whose input
      // differs as a mismatch. For our own stored Work that is the same
      // fingerprint set re-notified with re-rendered text: the same round.
      const stored = await runtime.store.readTask({ workId });
      if (
        stored !== undefined &&
        isOwnOncallWork(stored.task.work, request.principal, request.groupKey)
      )
        return { workId, duplicate: true };
      throw new ClawAdmissionConflict('groupKey names incompatible Work');
    }
    if (outcome.reason === 'task-closed')
      throw new ClawAdmissionConflict(
        'This alert group was canceled; it cannot be readmitted',
      );
    throw new Error(`Oncall alert admission refused: ${outcome.reason}`);
  }
  return { workId, duplicate: false };
}

/**
 * Resolves an Alertmanager group: a pending (unclaimed) round is canceled
 * and its desired revision cleared, so no successor is admitted; a claimed
 * attempt keeps its claim and finishes. A group this principal never
 * admitted reads exactly like one with nothing to invalidate, so the route
 * leaks no other principal's Work.
 */
export async function resolveOncallAlert(
  runtime: ClawAdmissionRuntime,
  request: { groupKey: string; principal: string },
  observedAt: string = new Date().toISOString(),
): Promise<{ workId?: string; invalidated: boolean }> {
  const workId = await runtime.store.readSourceWorkId(
    oncallSourceKey(request.principal, request.groupKey),
  );
  if (workId === undefined) return { invalidated: false };
  const stored = await runtime.store.readTask({ workId });
  if (
    stored === undefined ||
    !isOwnOncallWork(stored.task.work, request.principal, request.groupKey)
  )
    return { invalidated: false };
  const runs = (await runtime.store.listRuns({ workId })).sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.runId.localeCompare(a.runId, undefined, { numeric: true }),
  );
  const latest = runs[0];
  if (latest === undefined) return { workId, invalidated: false };
  const result = await runtime.orchestrator.invalidateSource(latest.runId, {
    alertmanager: observedAt,
  });
  if (isRefusal(result))
    throw new Error(`Oncall alert invalidation refused: ${result.reason}`);
  // Invalidation clears the desired revision (design: resolution invalidates
  // pending rounds); `invalidated` reports whether this call cleared one.
  const after = await runtime.store.readTask({ workId });
  return {
    workId,
    invalidated:
      stored.task.desiredRevision !== undefined &&
      after?.task.desiredRevision === undefined,
  };
}
