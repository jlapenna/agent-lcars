import {
  getNextPublicFirebaseApiKey,
  getNextPublicFirebaseAppId,
  getNextPublicFirebaseAuthDomain,
  getNextPublicFirebaseMessagingSenderId,
  getNextPublicFirebaseProjectId,
  getNextPublicFirebaseStorageBucket,
} from '@repo/util/browser';

/**
 * Firebase client SDK config, shared across every app that initializes a
 * client-side Firebase app (#2127 — this file was byte-identical across
 * members/onecake/primes before being centralized here).
 */
export const clientConfig = {
  apiKey: getNextPublicFirebaseApiKey(),
  authDomain: getNextPublicFirebaseAuthDomain(),
  projectId: getNextPublicFirebaseProjectId(),
  storageBucket: getNextPublicFirebaseStorageBucket(),
  messagingSenderId: getNextPublicFirebaseMessagingSenderId(),
  appId: getNextPublicFirebaseAppId(),
};
