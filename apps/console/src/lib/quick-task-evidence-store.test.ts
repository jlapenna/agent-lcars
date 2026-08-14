import { describe, expect, it } from 'vitest';

import {
  type QuickTaskEvidenceBinding,
  type QuickTaskNormalizedEvidence,
} from './quick-task-evidence-contract';
import { GcsQuickTaskEvidenceStore } from './quick-task-evidence-store';

const evidenceId = '0d6a4b56-31d0-4d39-b0b2-5a2520cc4882';
const binding: QuickTaskEvidenceBinding = {
  schemaVersion: 'v1',
  evidenceId,
  requestId: 'request-1',
  repositoryId: 42,
  normalizedSha256: 'a'.repeat(64),
  visibilityAtUpload: 'private',
  createdAt: '2026-08-14T00:00:00.000Z',
};
const evidence: QuickTaskNormalizedEvidence = {
  bytes: new Uint8Array([1, 2, 3]),
  contentType: 'image/webp',
  sha256: binding.normalizedSha256,
  width: 1,
  height: 1,
};

function bucketThatFailsSave(code: number) {
  return {
    file: () => ({ save: async () => Promise.reject({ code }) }),
  };
}

describe('GcsQuickTaskEvidenceStore.create', () => {
  it('maps only a create-only precondition failure to a binding conflict', async () => {
    const store = new GcsQuickTaskEvidenceStore(
      bucketThatFailsSave(412) as never,
    );

    await expect(store.create(evidence, binding)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('keeps other storage failures unavailable for callers to retry', async () => {
    const store = new GcsQuickTaskEvidenceStore(
      bucketThatFailsSave(500) as never,
    );

    await expect(store.create(evidence, binding)).rejects.toMatchObject({
      statusCode: 503,
    });
  });
});
