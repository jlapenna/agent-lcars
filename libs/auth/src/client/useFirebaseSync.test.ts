import { renderHook, waitFor } from '@testing-library/react';
import { signInWithCustomToken } from 'firebase/auth';
import { useSession } from 'next-auth/react';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { useFirebaseSync } from './useFirebaseSync';

vi.mock('firebase/auth');
vi.mock('next-auth/react', () => ({
  useSession: vi.fn(),
}));

describe('useFirebaseSync', () => {
  const mockAuth = {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should sign in to firebase when session has a firebaseToken', async () => {
    (useSession as Mock).mockReturnValue({
      data: {
        firebaseToken: 'mock-firebase-token',
      },
      status: 'authenticated',
    });

    renderHook(() => useFirebaseSync(mockAuth as any));

    await waitFor(() => {
      expect(signInWithCustomToken).toHaveBeenCalledWith(
        mockAuth,
        'mock-firebase-token',
      );
    });
  });

  it('should not sign in to firebase when session has no firebaseToken', async () => {
    (useSession as Mock).mockReturnValue({
      data: {},
      status: 'authenticated',
    });

    renderHook(() => useFirebaseSync({} as any));

    expect(signInWithCustomToken).not.toHaveBeenCalled();
  });

  it('should not sign in to firebase when status is loading', async () => {
    (useSession as Mock).mockReturnValue({
      status: 'loading',
    });

    renderHook(() => useFirebaseSync({} as any));

    expect(signInWithCustomToken).not.toHaveBeenCalled();
  });

  it('should not log to console when unauthenticated', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(vi.fn());
    (useSession as Mock).mockReturnValue({
      data: null,
      status: 'unauthenticated',
    });

    renderHook(() => useFirebaseSync({} as any));

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should log error when firebase auth is undefined', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());
    (useSession as Mock).mockReturnValue({
      data: {
        firebaseToken: 'mock-firebase-token',
      },
      status: 'authenticated',
    });

    renderHook(() => useFirebaseSync(undefined));

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cannot sync with Firebase'),
      );
    });
    consoleSpy.mockRestore();
  });
});
