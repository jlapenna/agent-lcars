import 'server-only';

import { createHash } from 'node:crypto';

import {
  CLAW_INVESTIGATE_OPERATION,
  clawInvestigateInputSchema,
} from '@agent-lcars/dispatch-contracts';
import {
  isRefusal,
  type Orchestrator,
  type OrchestratorStore,
  workRevisionSchema,
} from '@agent-lcars/orchestrator';
import {
  clawWorkSpecSchema,
  storedWorkPayloadSchema,
  ulid,
  WORK_TITLE_MAX,
} from '@agent-lcars/work';

export const CLAW_INVESTIGATOR_PIPELINE = 'claw-investigator' as const;

export interface ClawAdmissionRuntime {
  store: OrchestratorStore;
  orchestrator: Orchestrator;
}

/** Refusals the caller can act on; everything else is a server failure. */
export class ClawAdmissionConflict extends Error {
  override readonly name = 'ClawAdmissionConflict';
}

/** Source-key based, never a question: the stored spec is immutable, while
 * every round under the key may ask a different question. */
function investigationText(sourceKey: string): {
  title: string;
  description: string;
} {
  const title = `Claw investigation ${sourceKey}`;
  return {
    title:
      title.length <= WORK_TITLE_MAX
        ? title
        : `${title.slice(0, WORK_TITLE_MAX - 1)}…`,
    description: `Read-only claw investigation for source key ${sourceKey}. Each round's question is its own revision input.`,
  };
}

/**
 * Admits one read-only `investigate:v1` round for `claw/investigator`.
 *
 * Modelled on fleet triage and Inbox summaries: `(operation, sourceKey)`
 * resolves to one stable Work id, the question is the immutable revision
 * input and never part of the stored spec, a repeated question is the same round, and a new question for the
 * same key supersedes a queued one. Without a `sourceKey` every call admits
 * a new item. Keys are scoped to the admitting principal, and stored Work
 * owned by another principal is never compatible. The origin is the
 * authenticated principal on the `console`
 * channel with no thread: completion is persisted only, never delivered.
 */
export async function admitInvestigation(
  runtime: ClawAdmissionRuntime,
  request: { question: string; sourceKey?: string; principal: string },
): Promise<{ workId: string; duplicate: boolean }> {
  const input = clawInvestigateInputSchema.parse({
    question: request.question,
  });
  const sourceKey = request.sourceKey ?? `adhoc:${ulid()}`;
  // The source key is namespaced by principal: one caller's key can never
  // resolve to, supersede or read another caller's investigation.
  const workId = await runtime.store.resolveSourceWorkId(
    `${CLAW_INVESTIGATE_OPERATION}:${request.principal}:${sourceKey}`,
    ulid(),
  );
  const revisionInput = { operation: CLAW_INVESTIGATE_OPERATION, ...input };
  const revision = workRevisionSchema.parse({
    key: createHash('sha256')
      .update(JSON.stringify(revisionInput))
      .digest('hex'),
    input: revisionInput,
  });
  const spec = clawWorkSpecSchema.parse({
    ...investigationText(sourceKey),
    pipeline: CLAW_INVESTIGATOR_PIPELINE,
    priority: 'background',
    operation: CLAW_INVESTIGATE_OPERATION,
    sourceKey,
  });
  const outcome = await runtime.orchestrator.request({
    taskId: { workId },
    requestId: revision.key,
    pipeline: spec.pipeline,
    priority: spec.priority,
    params: { mode: 'claw' },
    work: {
      origin: { principal: request.principal, channel: 'console' },
      spec,
    },
    sourceRevision: revision,
    isStoredWorkCompatible: (stored) => {
      const parsed = storedWorkPayloadSchema.safeParse(stored);
      if (!parsed.success) return false;
      if (parsed.data.origin?.principal !== request.principal) return false;
      const claw = clawWorkSpecSchema.safeParse(parsed.data.spec);
      return (
        claw.success &&
        claw.data.pipeline === CLAW_INVESTIGATOR_PIPELINE &&
        claw.data.operation === CLAW_INVESTIGATE_OPERATION &&
        claw.data.sourceKey === sourceKey
      );
    },
  });
  if (isRefusal(outcome)) {
    if (outcome.reason === 'duplicate-request')
      return { workId, duplicate: true };
    if (
      outcome.reason === 'work-spec-mismatch' ||
      outcome.reason === 'task-closed'
    )
      throw new ClawAdmissionConflict(
        outcome.reason === 'task-closed'
          ? 'This investigation was canceled; admit it under a new sourceKey'
          : 'sourceKey names incompatible Work',
      );
    throw new Error(`Claw investigation admission refused: ${outcome.reason}`);
  }
  return { workId, duplicate: false };
}
