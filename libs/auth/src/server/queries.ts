import { createConverter } from '@members/shared/firestore';
import { Firestore, Transaction, UpdateData } from 'firebase-admin/firestore';

import {
  AuthJsAccount,
  AuthJsAccountSchema,
  AuthJsUser,
  AuthJsUserSchema,
} from './schema';

const authJsUserConverter = createConverter(AuthJsUserSchema, {
  idField: 'id',
});
const authJsAccountConverter = createConverter(AuthJsAccountSchema, {
  idField: 'id',
});

function getUsersCollection(firestore: Firestore) {
  return firestore
    .collection('services/authjs/users')
    .withConverter(authJsUserConverter);
}

function getAccountsCollection(firestore: Firestore) {
  return firestore
    .collection('services/authjs/accounts')
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
  return getAccountsCollection(firestore).doc(
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
  const snapshot = await getUsersCollection(firestore)
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
      getUsersCollection(firestore).where('slack.id', 'in', chunk).get(),
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
  const snapshot = await getUsersCollection(firestore)
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

  const docRef = await getUsersCollection(firestore).add(newUser);

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
  const snapshot = await getAccountsCollection(firestore)
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
      getAccountsCollection(firestore)
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
  const snapshot = await getUsersCollection(firestore).get();
  return snapshot.docs.map((d) => d.data());
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
  const ref = firestore.collection('services/authjs/accounts').doc(accountId);

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
  const ref = firestore.collection('services/authjs/accounts').doc(accountId);

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
