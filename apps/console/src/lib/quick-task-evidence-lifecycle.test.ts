import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  deleteGeneration: vi.fn(),
  normalize: vi.fn(),
}));

vi.mock('./quick-task-evidence-store', () => ({
  quickTaskEvidenceStore: vi.fn(() => ({
    create: mocks.create,
    deleteGeneration: mocks.deleteGeneration,
  })),
}));
vi.mock('./quick-task-image', () => ({
  normalizeQuickTaskEvidence: mocks.normalize,
}));

import { createQuickTaskEvidenceLifecycle } from './quick-task-evidence-lifecycle';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.normalize.mockResolvedValue({
    bytes: new Uint8Array([1]),
    contentType: 'image/webp',
    sha256: 'a'.repeat(64),
    width: 1,
    height: 1,
  });
});

describe('native Work evidence lifecycle', () => {
  it('binds evidence to the immutable Work id and does not delete a recovered replay', async () => {
    const recovered = {
      generation: '7',
      createdByCall: false,
      binding: {},
    };
    mocks.create.mockResolvedValue(recovered);
    const lifecycle = await createQuickTaskEvidenceLifecycle({
      bucket: 'evidence',
      evidenceId: '22222222-2222-4222-8222-222222222222',
      bytes: new Uint8Array([1]),
      createdAt: '2026-09-10T00:00:00.000Z',
    });
    await lifecycle.prepare({
      intent: {
        workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
        requestId: 'request-1',
        evidenceId: '22222222-2222-4222-8222-222222222222',
        repository: { owner: 'jlapenna', name: 'agent-lcars' },
        pipeline: 'codex',
        description: 'Fix this',
        source: {
          route: '/',
          identities: '',
          capturedAt: '2026-09-10T00:00:00.000Z',
        },
      },
      repositoryId: 42,
      visibility: 'private',
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requestId: 'request-1',
        workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
      }),
    );

    await lifecycle.rollbackDefinitiveCreateFailure(recovered);
    expect(mocks.deleteGeneration).not.toHaveBeenCalled();
  });
});
