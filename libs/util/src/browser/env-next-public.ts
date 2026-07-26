/**
 * Environment variable getters that are safe for use in the browser.
 * These should ONLY access NEXT_PUBLIC_ variables or other variables
 * that are explicitly allowed to be exposed to the client.
 *
 * NOTE: We use literal process.env access here (e.g. process.env.NEXT_PUBLIC_VAR)
 * to ensure that Next.js can correctly inline these values during the build process.
 * Dynamic access like process.env[key] will NOT be inlined and will return undefined
 * on the client.
 */

const sanitize = (value: string | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const lower = value.toLowerCase();
  if (lower === 'undefined' || lower === 'null') return undefined;
  return value;
};

export const getNextPublicProjectId = () =>
  sanitize(process.env.NEXT_PUBLIC_PROJECT_ID) || '';

export const getNextPublicFirebaseApiKey = () =>
  sanitize(process.env.NEXT_PUBLIC_FIREBASE_API_KEY);
export const getNextPublicFirebaseAppId = () =>
  sanitize(process.env.NEXT_PUBLIC_FIREBASE_APP_ID);
export const getNextPublicFirebaseAuthDomain = () =>
  sanitize(process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN);
export const getNextPublicFirebaseMessagingSenderId = () =>
  sanitize(process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID);
export const getNextPublicFirebaseProjectId = () =>
  sanitize(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID);
export const getNextPublicFirebaseStorageBucket = () =>
  sanitize(process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET);

export const getNextPublicFirebaseAuthEmulatorHost = () =>
  sanitize(process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST);

export const getNextPublicFirestoreEmulatorHost = () =>
  sanitize(process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST);
