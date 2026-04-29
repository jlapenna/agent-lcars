import { renderHook, waitFor } from '@testing-library/react';
import { signInWithCustomToken } from 'firebase/auth';
import { useSession } from 'next-auth/react';

import { useFirebaseSync } from './useFirebaseSync';

jest.mock('firebase/auth');
describe('useFirebaseSync', () => {
  const mockAuth = {};

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should sign in to firebase when session has a firebaseToken', async () => {
    (useSession as jest.Mock).mockReturnValue({
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
    (useSession as jest.Mock).mockReturnValue({
      data: {},
      status: 'authenticated',
    });

    renderHook(() => useFirebaseSync({} as any));

    expect(signInWithCustomToken).not.toHaveBeenCalled();
  });

  it('should not sign in to firebase when status is loading', async () => {
    (useSession as jest.Mock).mockReturnValue({
      status: 'loading',
    });

    renderHook(() => useFirebaseSync({} as any));

    expect(signInWithCustomToken).not.toHaveBeenCalled();
  });

  it('should not log to console when unauthenticated', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(jest.fn());
    (useSession as jest.Mock).mockReturnValue({
      data: null,
      status: 'unauthenticated',
    });

    renderHook(() => useFirebaseSync({} as any));

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should log error when firebase auth is undefined', async () => {
    const consoleSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(jest.fn());
    (useSession as jest.Mock).mockReturnValue({
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
