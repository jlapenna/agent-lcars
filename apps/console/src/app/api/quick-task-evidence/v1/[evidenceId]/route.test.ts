import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-13T00:00:00.000Z'));
  mocks.store.mockReturnValue({
    isRevoked: mocks.isRevoked,
    read: mocks.read,
    readObject: mocks.readObject,
  });
  mocks.isRevoked.mockResolvedValue(false);
  mocks.readObject.mockResolvedValue({
    generation: '1',
    uploadedAt: '2026-10-12T00:00:00.000Z',
    binding: { createdAt: '2026-10-12T00:00:00.000Z' },
  });
});

afterEach(() => vi.restoreAllMocks());

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

    const response = await HEAD(new Request('https://example.test'), context());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(await response.text()).toBe('');
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each([
    ['just before expiry', '2026-09-13T00:00:00.001Z', 200],
    ['exactly expired', '2026-09-13T00:00:00.000Z', 404],
    ['older than expiry', '2026-09-12T23:59:59.999Z', 404],
    ['future', '2026-10-13T00:00:00.001Z', 404],
    [
      'future within the current millisecond',
      '2026-10-13T00:00:00.000001Z',
      404,
    ],
    ['missing', undefined, 404],
    ['null', null, 404],
    ['malformed', 'not-a-date', 404],
    ['normalized invalid day', '2026-02-30T00:00:00.000Z', 404],
    ['local date', '2026-10-12', 404],
    ['non-UTC', '2026-10-12T00:00:00.000+01:00', 404],
    ['storage submillisecond precision', '2026-10-12T00:00:00.123456Z', 200],
  ])(
    'uses server upload age for GET and HEAD: %s',
    async (_name, uploadedAt, status) => {
      mocks.readObject.mockResolvedValue({
        generation: '1',
        uploadedAt,
        binding: { createdAt: '2026-10-13T00:00:00.000Z' },
      });
      mocks.read.mockResolvedValue(new Uint8Array([1, 2, 3]));
      for (const method of [GET, HEAD]) {
        const response = await method(
          new Request('https://example.test'),
          context(),
        );
        expect(response.status).toBe(status);
        if (status === 404) {
          expect([...response.headers]).toEqual([]);
          expect(await response.text()).toBe('');
        }
      }
      if (status === 404) expect(mocks.read).not.toHaveBeenCalled();
    },
  );

  it('does not read object metadata or bytes for revoked evidence', async () => {
    mocks.isRevoked.mockResolvedValue(true);
    const response = await GET(new Request('https://example.test'), context());
    expect(response.status).toBe(404);
    expect(mocks.readObject).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('fails closed when server creation metadata cannot be read', async () => {
    mocks.readObject.mockRejectedValue(new Error('unavailable'));
    for (const method of [GET, HEAD]) {
      const response = await method(
        new Request('https://example.test'),
        context(),
      );
      expect(response.status).toBe(404);
      expect([...response.headers]).toEqual([]);
    }
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
