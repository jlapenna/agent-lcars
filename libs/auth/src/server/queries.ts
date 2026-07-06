// Owned constants for the Auth.js Firestore paths (#2126). They live in the
// dependency-free @repo/authjs-paths so libraries with a real functional
// dependency on @repo/auth (e.g. @repo/strava, whose OAuth secrets config.ts
// imports) can reference them without forming a circular build dependency.
// Re-exported here for existing @repo/auth/server consumers.
import {
  AUTHJS_ACCOUNTS_COLLECTION_PATH,
  AUTHJS_SESSIONS_COLLECTION_PATH,
  AUTHJS_USERS_COLLECTION_PATH,
  AUTHJS_VERIFICATION_TOKENS_COLLECTION_PATH,
} from '@repo/authjs-paths';
import { createConverter } from '@repo/firestore';
import {
  FieldPath,
  Firestore,
  Transaction,
  UpdateData,
} from 'firebase-admin/firestore';

import {
  AuthJsAccount,
  AuthJsAccountSchema,
  AuthJsUser,
  AuthJsUserSchema,
} from './schema';

export {
  AUTHJS_ACCOUNTS_COLLECTION_PATH,
  AUTHJS_SESSIONS_COLLECTION_PATH,
  AUTHJS_USERS_COLLECTION_PATH,
  AUTHJS_VERIFICATION_TOKENS_COLLECTION_PATH,
};

const authJsUserConverter = createConverter(AuthJsUserSchema, {
  idField: 'id',
});
const authJsAccountConverter = createConverter(AuthJsAccountSchema, {
  idField: 'id',
});

export function getAuthJsUsersCollection(firestore: Firestore) {
  return firestore
    .collection(AUTHJS_USERS_COLLECTION_PATH)
    .withConverter(authJsUserConverter);
}

export function getAuthJsAccountsCollection(firestore: Firestore) {
  return firestore
    .collection(AUTHJS_ACCOUNTS_COLLECTION_PATH)
    .withConverter(authJsAccountConverter);
}

/**
 * Resolves a deterministic document ID for an Auth.js account.
 */
export function getAuthJsAccountId(userId: string, provider: string): string {
  return `${userId}_${provider}`;
}

/**
 * Resolves an Auth.js account reference.
 */
export function getAuthJsAccountRef(
  firestore: Firestore,
  userId: string,
  provider: string,
) {
  return getAuthJsAccountsCollection(firestore).doc(
    getAuthJsAccountId(userId, provider),
  );
}

/**
 * Find an Auth.js user by their Slack ID.
 * Slack IDs are stored in the custom 'slack.id' field.
 */
export async function getAuthJsUserBySlackId(
  firestore: Firestore,
  slackId: string,
): Promise<AuthJsUser | undefined> {
  const snapshot = await getAuthJsUsersCollection(firestore)
    .where('slack.id', '==', slackId)
    .limit(1)
    .get();

  if (snapshot.empty) {
    return undefined;
  }
  return snapshot.docs[0].data();
}

/**
 * Find multiple Auth.js users by their Slack IDs in a single query.
 */
export async function getAuthJsUsersBySlackIds(
  firestore: Firestore,
  slackIds: string[],
): Promise<AuthJsUser[]> {
  if (slackIds.length === 0) return [];

  // Firestore 'in' queries are limited to 30 values.
  // We chunk the IDs to handle larger roster sizes.
  const chunks: string[][] = [];
  for (let i = 0; i < slackIds.length; i += 30) {
    chunks.push(slackIds.slice(i, i + 30));
  }

  const results = await Promise.all(
    chunks.map((chunk) =>
      getAuthJsUsersCollection(firestore).where('slack.id', 'in', chunk).get(),
    ),
  );

  return results.flatMap((snapshot) => snapshot.docs.map((d) => d.data()));
}

/**
 * Find multiple Auth.js users by their User IDs (UUIDs) in a single query.
 */
export async function getAuthJsUsersByUserIds(
  firestore: Firestore,
  userIds: string[],
): Promise<AuthJsUser[]> {
  if (userIds.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < userIds.length; i += 30) {
    chunks.push(userIds.slice(i, i + 30));
  }

  const results = await Promise.all(
    chunks.map((chunk) =>
      getAuthJsUsersCollection(firestore)
        .where(FieldPath.documentId(), 'in', chunk)
        .get(),
    ),
  );

  return results.flatMap((snapshot) => snapshot.docs.map((d) => d.data()));
}

/**
 * Find an Auth.js user by their email.
 */
export async function getAuthJsUserByEmail(
  firestore: Firestore,
  email: string,
): Promise<AuthJsUser | undefined> {
  const snapshot = await getAuthJsUsersCollection(firestore)
    .where('email', '==', email)
    .limit(1)
    .get();

  if (snapshot.empty) {
    return undefined;
  }
  return snapshot.docs[0].data();
}

/**
 * Ensures an Auth.js user exists for a given Slack profile.
 * Creates one if it doesn't exist.
 */
export async function ensureAuthJsUserForSlack(
  firestore: Firestore,
  slackUser: {
    id: string;
    name?: string;
    email?: string;
    image?: string;
    teamId?: string;
  },
): Promise<AuthJsUser> {
  const existing = await getAuthJsUserBySlackId(firestore, slackUser.id);
  if (existing) {
    return existing;
  }

  // Fallback: NextAuth strips custom fields like `slack.id` when creating the user.
  // Find the real user by querying the accounts collection using the Slack provider ID.
  const accountSnapshot = await getAuthJsAccountsCollection(firestore)
    .where('provider', '==', 'slack')
    .where('providerAccountId', '==', slackUser.id)
    .limit(1)
    .get();

  if (!accountSnapshot.empty) {
    const account = accountSnapshot.docs[0].data();
    if (account.userId) {
      const userDoc = await getAuthJsUsersCollection(firestore)
        .doc(account.userId)
        .get();
      const user = userDoc.data();
      if (userDoc.exists && user) {
        // Backfill the missing slack.id so we don't have to fallback again
        await userDoc.ref.update({
          'slack.id': slackUser.id,
          ...(slackUser.teamId && { 'slack.teamId': slackUser.teamId }),
        });

        return user;
      }
    }
  }

  // Fallback 2: Look up by email (since NextAuth might have generated a UUID for providerAccountId)
  if (slackUser.email) {
    const user = await getAuthJsUserByEmail(firestore, slackUser.email);
    if (user && user.id) {
      const userDoc = await getAuthJsUsersCollection(firestore)
        .doc(user.id)
        .get();
      if (userDoc.exists) {
        // Backfill the missing slack.id so we don't have to fallback again
        await userDoc.ref.update({
          'slack.id': slackUser.id,
          ...(slackUser.teamId && { 'slack.teamId': slackUser.teamId }),
        });
        return userDoc.data() as AuthJsUser;
      }
    }
  }

  // Create new user document
  const newUser: AuthJsUser = {
    name: slackUser.name,
    email: slackUser.email,
    image: slackUser.image,
    slack: {
      id: slackUser.id,
      teamId: slackUser.teamId,
    },
  };

  const docRef = await getAuthJsUsersCollection(firestore).add(newUser);

  return { ...newUser, id: docRef.id };
}

/**
 * Retrieve a specific OAuth account for an Auth.js user.
 */
export async function getAuthJsAccount(
  firestore: Firestore,
  userId: string,
  provider: string,
): Promise<AuthJsAccount | undefined> {
  const doc = await getAuthJsAccountRef(firestore, userId, provider).get();
  if (doc.exists) return doc.data();

  // Fallback to legacy query-based lookup for accounts without deterministic IDs
  const snapshot = await getAuthJsAccountsCollection(firestore)
    .where('userId', '==', userId)
    .where('provider', '==', provider)
    .limit(1)
    .get();

  return snapshot.docs[0]?.data();
}

/**
 * Retrieve multiple OAuth accounts for a set of users in a single query.
 */
export async function getAuthJsAccountsByUserIds(
  firestore: Firestore,
  userIds: string[],
  provider: string,
): Promise<AuthJsAccount[]> {
  if (userIds.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < userIds.length; i += 30) {
    chunks.push(userIds.slice(i, i + 30));
  }

  const results = await Promise.all(
    chunks.map((chunk) =>
      getAuthJsAccountsCollection(firestore)
        .where('userId', 'in', chunk)
        .where('provider', '==', provider)
        .get(),
    ),
  );

  return results.flatMap((snapshot) => snapshot.docs.map((d) => d.data()));
}

/**
 * Retrieve all Auth.js users.
 * @deprecated Use getAuthJsUsersBySlackIds for better performance on large datasets.
 */
export async function getAllAuthJsUsers(
  firestore: Firestore,
): Promise<AuthJsUser[]> {
  const snapshot = await getAuthJsUsersCollection(firestore).get();
  return snapshot.docs.map((d) => d.data());
}

/**
 * Grant or revoke the persisted admin flag on an Auth.js user doc. The auth
 * session callback ORs this into `session.user.isAdmin`, so the change takes
 * effect on the user's next request (database sessions recompute per-request).
 */
export async function setAuthJsUserAdmin(
  firestore: Firestore,
  userId: string,
  isAdmin: boolean,
): Promise<void> {
  await firestore
    .collection(AUTHJS_USERS_COLLECTION_PATH)
    .doc(userId)
    .set({ isAdmin }, { merge: true });
}

/**
 * Update an Auth.js account with new token data.
 */
export async function updateAuthJsAccount(
  firestore: Firestore,
  accountId: string,
  data: Partial<AuthJsAccount>,
  transaction?: Transaction,
) {
  const ref = getAuthJsAccountsCollection(firestore).doc(accountId);

  if (transaction) {
    transaction.update(ref, data as unknown as UpdateData<AuthJsAccount>);
  } else {
    await ref.update(data as unknown as UpdateData<AuthJsAccount>);
  }
}

/**
 * Delete an Auth.js account.
 */
export async function deleteAuthJsAccount(
  firestore: Firestore,
  accountId: string,
  transaction?: Transaction,
) {
  const ref = getAuthJsAccountsCollection(firestore).doc(accountId);

  if (transaction) {
    transaction.delete(ref);
  } else {
    await ref.delete();
  }
}

/**
 * Upserts an Auth.js account for a user and provider using deterministic document IDs.
 * This ensures that token data is always up to date and is safe for use within transactions.
 */
export async function upsertAuthJsAccount(
  firestore: Firestore,
  accountData: AuthJsAccount,
  transaction?: Transaction,
) {
  const ref = getAuthJsAccountRef(
    firestore,
    accountData.userId,
    accountData.provider,
  );

  if (transaction) {
    transaction.set(ref, accountData, { merge: true });
  } else {
    await ref.set(accountData, { merge: true });
  }
}
