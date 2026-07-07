import {
  getNextPublicFirebaseAuthEmulatorHost,
  getNextPublicFirestoreEmulatorHost,
} from '@repo/util/browser';
import { FirebaseApp, getApp, getApps, initializeApp } from 'firebase/app';
import {
  Auth,
  connectAuthEmulator,
  getAuth,
  inMemoryPersistence,
  setPersistence,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  Firestore,
  getFirestore as getFirestoreClient,
} from 'firebase/firestore';

import { clientConfig } from './firebase-client-config';

export interface FirebaseBrowserClientOptions {
  /**
   * Keep Firebase Auth from persisting credentials in the browser at all
   * (session lives only in memory). Only primes wants this today — see the
   * rationale linked next to the `setPersistence` call below.
   */
  inMemoryAuthPersistence?: boolean;
}

export interface FirebaseBrowserClient {
  getApp(): FirebaseApp | undefined;
  getAuth(): Auth | undefined;
  getFirestore(): Firestore | undefined;
}

/**
 * Builds a Firebase browser client (app + auth + firestore), each piece
 * lazily created and cached on first use. Call this once per app at module
 * scope and re-export the getters the app needs.
 */
export function createFirebaseBrowserClient(
  options: FirebaseBrowserClientOptions = {},
): FirebaseBrowserClient {
  let app: FirebaseApp | undefined;

  const getFirebaseApp = (): FirebaseApp | undefined => {
    if (app) {
      return app;
    }

    if (getApps().length > 0) {
      app = getApp();
      return app;
    }

    if (!clientConfig.apiKey) {
      console.error(
        'Firebase Error: API Key is missing. Check your environment variables.',
      );
      return undefined;
    }

    try {
      app = initializeApp(clientConfig);
      return app;
    } catch (error) {
      console.error('Failed to initialize Firebase:', error);
      return undefined;
    }
  };

  let authInstance: Auth | undefined;

  const getFirebaseAuth = (): Auth | undefined => {
    if (authInstance) {
      return authInstance;
    }

    const appInstance = getFirebaseApp();
    if (!appInstance) {
      return undefined;
    }

    authInstance = getAuth(appInstance);

    if (options.inMemoryAuthPersistence) {
      // App relies only on server token. We make sure Firebase does not store credentials in the browser.
      // See: https://github.com/awinogrodzki/next-firebase-auth-edge/issues/143
      setPersistence(authInstance, inMemoryPersistence);
    }

    const authEmulatorHost = getNextPublicFirebaseAuthEmulatorHost();
    if (authEmulatorHost) {
      if (options.inMemoryAuthPersistence) {
        // https://stackoverflow.com/questions/73605307/firebase-auth-emulator-fails-intermittently-with-auth-emulator-config-failed
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (authInstance as unknown as any)._canInitEmulator = true;
      }
      connectAuthEmulator(authInstance, authEmulatorHost, {
        disableWarnings: true,
      });
    }

    return authInstance;
  };

  let firestoreInstance: Firestore | undefined;
  let firestoreEmulatorConnected = false;

  const getFirestore = (): Firestore | undefined => {
    const appInstance = getFirebaseApp();
    if (!appInstance) {
      return undefined;
    }

    if (!firestoreInstance) {
      firestoreInstance = getFirestoreClient(appInstance);
    }

    // Use together with Firestore Emulator https://cloud.google.com/firestore/docs/emulator#android_apple_platforms_and_web_sdks
    const firestoreEmulatorHost = getNextPublicFirestoreEmulatorHost();
    if (!firestoreEmulatorConnected && firestoreEmulatorHost) {
      firestoreEmulatorConnected = true;
      const [host, port] = firestoreEmulatorHost.split(':');
      connectFirestoreEmulator(firestoreInstance, host, Number(port));
    }

    return firestoreInstance;
  };

  return { getApp: getFirebaseApp, getAuth: getFirebaseAuth, getFirestore };
}
