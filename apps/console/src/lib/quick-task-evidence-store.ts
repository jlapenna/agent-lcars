import 'server-only';

import { type Bucket, Storage } from '@google-cloud/storage';

import {
  QUICK_TASK_EVIDENCE_SCHEMA_VERSION,
  type QuickTaskEvidenceBinding,
  QuickTaskEvidenceError,
  type QuickTaskEvidenceId,
  type QuickTaskEvidenceObject,
  quickTaskEvidenceObjectKey,
  quickTaskEvidenceRevocationKey,
  type QuickTaskEvidenceStore,
  type QuickTaskNormalizedEvidence,
} from './quick-task-evidence-contract';

const metadataFor = (binding: QuickTaskEvidenceBinding) => ({
  schemaVersion: binding.schemaVersion,
  evidenceId: binding.evidenceId,
  requestId: binding.requestId,
  repositoryId: String(binding.repositoryId),
  normalizedSha256: binding.normalizedSha256,
  visibilityAtUpload: binding.visibilityAtUpload,
  createdAt: binding.createdAt,
});

/** GCS reports a failed ifGenerationMatch precondition as HTTP 412. */
function isCreatePreconditionFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 412
  );
}

export class GcsQuickTaskEvidenceStore implements QuickTaskEvidenceStore {
  constructor(private readonly bucket: Bucket) {}
  async create(
    evidence: QuickTaskNormalizedEvidence,
    binding: QuickTaskEvidenceBinding,
  ): Promise<QuickTaskEvidenceObject> {
    const file = this.bucket.file(
      quickTaskEvidenceObjectKey(binding.evidenceId),
    );
    try {
      await file.save(evidence.bytes, {
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: {
          contentType: evidence.contentType,
          metadata: metadataFor(binding),
        },
      });
    } catch (error) {
      if (isCreatePreconditionFailure(error)) {
        throw new QuickTaskEvidenceError(409, 'Evidence binding conflict');
      }
      throw new QuickTaskEvidenceError(503, 'Evidence storage is unavailable');
    }
    const [metadata] = await file.getMetadata();
    return { binding, generation: String(metadata.generation) };
  }
  async read(evidenceId: QuickTaskEvidenceId) {
    try {
      const [bytes] = await this.bucket
        .file(quickTaskEvidenceObjectKey(evidenceId))
        .download();
      return bytes;
    } catch {
      return undefined;
    }
  }
  async readObject(evidenceId: QuickTaskEvidenceId) {
    try {
      const [data] = await this.bucket
        .file(quickTaskEvidenceObjectKey(evidenceId))
        .getMetadata();
      const m = data.metadata ?? {};
      if (m.schemaVersion !== QUICK_TASK_EVIDENCE_SCHEMA_VERSION)
        return undefined;
      return {
        generation: String(data.generation),
        binding: {
          schemaVersion: QUICK_TASK_EVIDENCE_SCHEMA_VERSION,
          evidenceId,
          requestId: m.requestId,
          repositoryId: Number(m.repositoryId),
          normalizedSha256: m.normalizedSha256,
          visibilityAtUpload: m.visibilityAtUpload,
          createdAt: m.createdAt,
        } as QuickTaskEvidenceBinding,
      };
    } catch {
      return undefined;
    }
  }
  async isRevoked(evidenceId: QuickTaskEvidenceId) {
    const [exists] = await this.bucket
      .file(quickTaskEvidenceRevocationKey(evidenceId))
      .exists();
    return exists;
  }
  async tombstone(binding: QuickTaskEvidenceBinding) {
    await this.bucket
      .file(quickTaskEvidenceRevocationKey(binding.evidenceId))
      .save('', {
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { metadata: metadataFor(binding) },
      });
  }
  async deleteGeneration(evidenceId: QuickTaskEvidenceId, generation: string) {
    await this.bucket
      .file(quickTaskEvidenceObjectKey(evidenceId))
      .delete({ ifGenerationMatch: Number(generation) });
  }
}

export function quickTaskEvidenceStore(
  bucketName: string,
): GcsQuickTaskEvidenceStore {
  if (!bucketName)
    throw new QuickTaskEvidenceError(503, 'Evidence storage is unavailable');
  return new GcsQuickTaskEvidenceStore(new Storage().bucket(bucketName));
}
