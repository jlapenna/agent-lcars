import { Firestore } from 'firebase-admin/firestore';
import { FakeFirestore } from 'firestore-jest-mock';

import { resolveUserIdFromSlackId } from './identity';
import { ensureAuthJsUserForSlack, upsertAuthJsAccount } from './queries';

// Mock queries
jest.mock('./queries', () => ({
  ensureAuthJsUserForSlack: jest.fn(),
  upsertAuthJsAccount: jest.fn(),
}));
jest.mock('@members/firebase-server', () => ({
  getFirestore: jest.fn(),
}));

describe('resolveUserIdFromSlackId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return existing userId if an AuthJsAccount is found', async () => {
    const firestore = new FakeFirestore(
      {
        services: [
          {
            id: 'authjs',
            _collections: {
              accounts: [
                {
                  id: 'uuid-1234_slack',
                  provider: 'slack',
                  providerAccountId: 'U123',
                  type: 'oauth',
                  userId: 'uuid-1234',
                },
              ],
            },
          },
        ],
      },
      { mutable: true, includeIdsInData: true },
    ) as unknown as Firestore;

    const result = await resolveUserIdFromSlackId(firestore, { id: 'U123' });
    expect(result).toBe('uuid-1234');
  });

  it('should lazily create a new user and account if none exists', async () => {
    const slackUser = {
      id: 'U456',
      name: 'Test User',
      email: 'test@example.com',
    };

    (ensureAuthJsUserForSlack as jest.Mock).mockResolvedValue({
      id: 'generated-uuid-5678',
      email: 'test@example.com',
    });

    const firestore = new FakeFirestore(
      {
        services: [
          {
            id: 'authjs',
            _collections: { accounts: [], users: [] },
          },
        ],
      },
      { mutable: true, includeIdsInData: true },
    ) as unknown as Firestore;

    const result = await resolveUserIdFromSlackId(firestore, slackUser);

    expect(result).toBe('generated-uuid-5678');
    expect(ensureAuthJsUserForSlack).toHaveBeenCalledWith(firestore, slackUser);
    expect(upsertAuthJsAccount).toHaveBeenCalledWith(
      firestore,
      expect.objectContaining({
        provider: 'slack',
        providerAccountId: 'U456',
        userId: 'generated-uuid-5678',
      }),
    );
  });
});
