import 'server-only';

import {
  QUICK_TASK_EVIDENCE_SCHEMA_VERSION,
  type QuickTaskEvidenceBinding,
  type QuickTaskEvidenceId,
  type QuickTaskEvidenceObject,
  type QuickTaskEvidencePreIssueCreateHook,
} from './quick-task-evidence-contract';
import { quickTaskEvidenceStore } from './quick-task-evidence-store';
import { normalizeQuickTaskEvidence } from './quick-task-image';

/**
 * Keeps the normalized browser file in one request-owned lifecycle object.
 * Reusing this object is the only safe in-process retry: it preserves the
 * request UUID, evidence UUID, and exact normalized bytes.
 */
export async function createQuickTaskEvidenceLifecycle(params: {
  bucket: string;
  evidenceId: QuickTaskEvidenceId;
  bytes: Uint8Array;
}): Promise<QuickTaskEvidencePreIssueCreateHook> {
  const evidence = await normalizeQuickTaskEvidence(params.bytes);
  const store = quickTaskEvidenceStore(params.bucket);

  return {
    async prepare({ intent, repositoryId, visibility }) {
      const binding: QuickTaskEvidenceBinding = {
        schemaVersion: QUICK_TASK_EVIDENCE_SCHEMA_VERSION,
        evidenceId: params.evidenceId,
        requestId: intent.requestId,
        repositoryId,
        normalizedSha256: evidence.sha256,
        visibilityAtUpload: visibility,
        createdAt: new Date().toISOString(),
      };
      return store.create(evidence, binding);
    },
    async rollbackDefinitiveCreateFailure(created: QuickTaskEvidenceObject) {
      await store.deleteGeneration(
        created.binding.evidenceId,
        created.generation,
      );
    },
  };
}
