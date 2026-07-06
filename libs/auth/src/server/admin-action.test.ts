import type { Session } from 'next-auth';

import { createAdminAction } from './admin-action';

function session(overrides: Partial<Session['user']> = {}): Session {
  return {
    user: { id: 'user-1', isAdmin: false, ...overrides },
    expires: new Date(Date.now() + 1000).toISOString(),
  } as Session;
}

describe('createAdminAction', () => {
  it('returns the session when the caller is an admin', async () => {
    const auth = jest.fn().mockResolvedValue(session({ isAdmin: true }));
    const adminAction = createAdminAction(auth);

    const result = await adminAction();

    expect(result.user.id).toBe('user-1');
    expect(auth).toHaveBeenCalledTimes(1);
  });

  it('throws Unauthorized when the caller is not an admin', async () => {
    const auth = jest.fn().mockResolvedValue(session({ isAdmin: false }));
    const adminAction = createAdminAction(auth);

    await expect(adminAction()).rejects.toThrow('Unauthorized');
  });

  it('throws Unauthorized when there is no session at all', async () => {
    const auth = jest.fn().mockResolvedValue(null);
    const adminAction = createAdminAction(auth);

    await expect(adminAction()).rejects.toThrow('Unauthorized');
  });

  it('each bound instance calls its own injected auth() function', async () => {
    const authA = jest.fn().mockResolvedValue(session({ isAdmin: true }));
    const authB = jest.fn().mockResolvedValue(session({ isAdmin: true }));
    const adminActionA = createAdminAction(authA);
    const adminActionB = createAdminAction(authB);

    await adminActionA();
    await adminActionB();

    expect(authA).toHaveBeenCalledTimes(1);
    expect(authB).toHaveBeenCalledTimes(1);
  });
});
