import { Firestore } from 'firebase-admin/firestore';

import {
  AUTHJS_ACCOUNTS_COLLECTION_PATH,
  AUTHJS_USERS_COLLECTION_PATH,
  ensureAuthJsUserForSlack,
  upsertAuthJsAccount,
} from './queries';
import { AuthJsAccount } from './schema';

/**
 * Resolves a canonical NextAuth UUID from a Slack user object.
 * If the user has never logged into the web application, this function
 * lazily generates a canonical UUID and creates the linked AuthJsAccount.
 *
 * This guarantees that "Slack-Only" users still have a unified identity
 * that can be safely referenced across the system.
 */
export async function resolveUserIdFromSlackId(
  firestore: Firestore,
  slackUser: {
    id: string;
    name?: string;
    email?: string;
    image?: string;
    teamId?: string;
  },
): Promise<string> {
  // 1. Try to find an existing AuthJsAccount for this Slack user
  const accountSnapshot = await firestore
    .collection(AUTHJS_ACCOUNTS_COLLECTION_PATH)
    .where('provider', '==', 'slack')
    .where('providerAccountId', '==', slackUser.id)
    .limit(1)
    .get();

  if (!accountSnapshot.empty) {
    const account = accountSnapshot.docs[0].data() as AuthJsAccount;
    if (account.userId) {
      return account.userId;
    }
  }

  // 2. If no account exists (or it's missing userId), lazily create the AuthJsUser.
  // ensureAuthJsUserForSlack will either find an existing user (e.g. by email/slack.id)
  // or create a completely new one and return the generated UUID.
  const user = await ensureAuthJsUserForSlack(firestore, slackUser);

  if (!user.id) {
    throw new Error('Failed to generate canonical UUID for Slack user');
  }

  // 3. Create the linked AuthJsAccount so NextAuth recognizes this connection natively.
  // We use upsertAuthJsAccount to ensure the deterministic ID format (`${userId}_slack`) is used.
  const accountData: AuthJsAccount = {
    provider: 'slack',
    providerAccountId: slackUser.id,
    type: 'oauth',
    userId: user.id,
  };

  await upsertAuthJsAccount(firestore, accountData);

  return user.id;
}

const isUuid = (id: string) => id.includes('-') && id.length >= 32;

/**
 * Read-only resolution of any rider identifier (a Slack ID or an already-canonical
 * NextAuth UUID) to the canonical UUID that the rider profile is keyed by.
 *
 * Unlike {@link resolveUserIdFromSlackId}, this never creates a user/account — use
 * it on read paths (e.g. the web `/profile/.../[id]` pages, where `id` is a Slack
 * ID in the URL). When duplicate auth users exist for one Slack ID it prefers the
 * UUID-format user (the canonical survivor) over a legacy auto-ID fork. Falls back
 * to the input id for Slack-only members whose profile still lives under their
 * Slack ID.
 */
export async function getCanonicalUserId(
  firestore: Firestore,
  id: string,
): Promise<string> {
  if (isUuid(id)) return id;

  // Slack ID → the userId on its slack account (the same path the bot uses).
  const accountSnapshot = await firestore
    .collection(AUTHJS_ACCOUNTS_COLLECTION_PATH)
    .where('provider', '==', 'slack')
    .where('providerAccountId', '==', id)
    .limit(1)
    .get();
  if (!accountSnapshot.empty) {
    const userId = (accountSnapshot.docs[0].data() as AuthJsAccount).userId;
    if (userId) return userId;
  }

  // Fallback: an auth user carrying this slack.id (prefer the canonical UUID).
  const usersSnapshot = await firestore
    .collection(AUTHJS_USERS_COLLECTION_PATH)
    .where('slack.id', '==', id)
    .get();
  if (!usersSnapshot.empty) {
    return (
      usersSnapshot.docs.map((d) => d.id).find(isUuid) ??
      usersSnapshot.docs[0].id
    );
  }

  return id;
}
