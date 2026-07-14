import { redirect } from 'next/navigation';
import type { Session } from 'next-auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { assertAdmin } from './assert-admin';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}));

function session(isAdmin: boolean): Session {
  return { user: { id: 'user-1', isAdmin } } as Session;
}

describe('assertAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not redirect when the session is an admin', () => {
    assertAdmin(session(true));
    expect(redirect).not.toHaveBeenCalled();
  });

  it('redirects to / by default when the session is not an admin', () => {
    assertAdmin(session(false));
    expect(redirect).toHaveBeenCalledWith('/');
  });

  it('redirects to / by default when there is no session', () => {
    assertAdmin(null);
    expect(redirect).toHaveBeenCalledWith('/');
  });

  it('redirects to a custom path when given one', () => {
    assertAdmin(session(false), '/login');
    expect(redirect).toHaveBeenCalledWith('/login');
  });
});
