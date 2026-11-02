import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  status: vi.fn(),
  receive: vi.fn(),
  pushSnapshot: vi.fn(),
}));
vi.mock('../../../auth', () => ({ auth: mocks.auth }));
vi.mock('../../../lib/deployment', () => ({
  isAdminGithubLogin: () => true,
}));
vi.mock('../../../lib/inbox-notifications', () => ({
  notificationSnapshotFresh: () => true,
}));
vi.mock('../../../lib/inbox-push', () => ({
  getInboxPushStore: () => ({ status: mocks.status, receive: mocks.receive }),
  pushSnapshot: mocks.pushSnapshot,
}));
import { POST } from './route';

const decision = { id: 'jlapenna/agent-lcars#2201', generation: 'g1' };
// App Hosting forwards to the internal Cloud Run host; browsers send the public one.
const checkIn = (origin?: string) =>
  POST(
    new Request(
      'https://agent-lcars-611425338852.us-central1.run.app/api/inbox-push',
      {
        method: 'POST',
        headers: origin ? { origin } : {},
        body: JSON.stringify({
          endpoint: 'https://push.example/e',
          attemptAt: 1,
        }),
      },
    ),
  );

beforeEach(() => {
  vi.stubEnv('AUTH_URL', 'https://lcars.jlapenna.net');
  mocks.auth.mockResolvedValue({
    user: { id: 'viewer', isAdmin: true, login: 'jlapenna' },
  });
  mocks.status.mockResolvedValue(true);
  mocks.pushSnapshot.mockResolvedValue({
    principalId: 'viewer',
    decisions: [decision],
  });
  mocks.receive.mockResolvedValue([decision]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe('worker check-in origin gate', () => {
  it('accepts the public AUTH_URL origin when request.url is the internal host', async () => {
    const response = await checkIn('https://lcars.jlapenna.net');
    expect(response.status).toBe(200);
    expect((await response.json()).decisions).toEqual([decision]);
  });
  it.each([
    ['a foreign origin', 'https://evil.example'],
    [
      'the internal host as origin',
      'https://agent-lcars-611425338852.us-central1.run.app',
    ],
    ['no origin', undefined],
  ])('rejects %s before reading the session', async (_, origin) => {
    const response = await checkIn(origin);
    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});
