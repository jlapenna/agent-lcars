import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isRevoked: vi.fn(),
  read: vi.fn(),
  readObject: vi.fn(),
  store: vi.fn(),
}));

vi.mock('../../../../../lib/quick-task-evidence-store', () => ({
  quickTaskEvidenceStore: mocks.store,
}));

import { GET, HEAD } from './route';

const evidenceId = '0d6a4b56-31d0-4d39-b0b2-5a2520cc4882';
const context = (id = evidenceId) => ({
  params: Promise.resolve({ evidenceId: id }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Quick Task evidence public route', () => {
  it('returns only normalized bytes and the frozen headers', async () => {
    mocks.store.mockReturnValue({
      isRevoked: mocks.isRevoked,
      read: mocks.read,
      readObject: mocks.readObject,
    });
    mocks.isRevoked.mockResolvedValue(false);
    mocks.read.mockResolvedValue(new Uint8Array([1, 2, 3]));

    const response = await GET(new Request('https://example.test'), context());

    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'cache-control': 'no-cache, max-age=0',
      'content-disposition': 'inline; filename="screenshot.webp"',
      'content-type': 'image/webp',
      'x-content-type-options': 'nosniff',
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it('uses the same response shape for malformed, revoked, absent, and unavailable evidence', async () => {
    mocks.store.mockReturnValue({
      isRevoked: mocks.isRevoked,
      read: mocks.read,
      readObject: mocks.readObject,
    });
    mocks.isRevoked.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.read
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('unavailable'));

    const responses = await Promise.all([
      GET(new Request('https://example.test'), context('not-a-uuid')),
      GET(new Request('https://example.test'), context()),
      GET(new Request('https://example.test'), context()),
      GET(new Request('https://example.test'), context()),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect([...response.headers]).toEqual([]);
      expect(await response.text()).toBe('');
    }
  });

  it('returns no body for HEAD while retaining successful headers', async () => {
    mocks.store.mockReturnValue({
      isRevoked: mocks.isRevoked,
      read: mocks.read,
      readObject: mocks.readObject,
    });
    mocks.isRevoked.mockResolvedValue(false);
    mocks.readObject.mockResolvedValue({ generation: '1', binding: {} });

    const response = await HEAD(new Request('https://example.test'), context());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(await response.text()).toBe('');
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
