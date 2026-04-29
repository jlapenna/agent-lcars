import { Auth, signInWithCustomToken } from 'firebase/auth';
import { useSession } from 'next-auth/react';
import * as React from 'react';

export function useFirebaseSync(auth: Auth | undefined | null) {
  const { data: session, status } = useSession();

  React.useEffect(() => {
    const syncFirebase = async () => {
      if (status === 'authenticated' && session?.firebaseToken) {
        if (auth) {
          try {
            await signInWithCustomToken(auth, session.firebaseToken as string);
          } catch (error) {
            console.error('Failed to sync with Firebase:', error);
          }
        } else {
          console.error(
            'Cannot sync with Firebase: Firebase Auth instance is undefined. Check client configuration.',
          );
        }
      }
    };

    void syncFirebase();
  }, [session?.firebaseToken, status]);
}
