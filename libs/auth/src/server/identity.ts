import { Firestore } from 'firebase-admin/firestore';

import { ensureAuthJsUserForSlack, upsertAuthJsAccount } from './queries';
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
    .collection('services/authjs/accounts')
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
