import { createHash } from 'node:crypto';

import { FieldPath, Firestore } from '@google-cloud/firestore';

/** Synthetic preferences only, in the same explicitly hermetic dispatch
 * emulator used by the running app. Never fall through to production ADC. */
function client() {
  if (
    process.env['E2E_HERMETIC'] !== '1' ||
    process.env['PROJECT_ID'] !== 'demo-no-project' ||
    !/^(127\.0\.0\.1|localhost):[0-9]+$/.test(
      process.env['FIRESTORE_EMULATOR_HOST'] ?? '',
    )
  )
    throw new Error('Decision fixtures require the hermetic loopback emulator');
  return new Firestore({
    projectId: 'demo-no-project',
    databaseId: process.env['DISPATCH_FIRESTORE_DATABASE_ID'] ?? '(default)',
  });
}
function document(firestore: Firestore, userId: string) {
  if (!['e2e-agent-lcars-admin', 'ungranted-admin'].includes(userId))
    throw new Error('Unknown synthetic maintainer');
  const id = createHash('sha256').update(`github:${userId}`).digest('hex');
  return firestore.collection('console-maintainer-preferences').doc(id);
}
export async function clearSnoozeFixtures() {
  const firestore = client();
  try {
    await Promise.all(
      ['e2e-agent-lcars-admin', 'ungranted-admin'].map((id) =>
        document(firestore, id).delete(),
      ),
    );
  } finally {
    await firestore.terminate();
  }
}
export async function seedUnrelatedPreference() {
  const firestore = client();
  try {
    await document(firestore, 'e2e-agent-lcars-admin').set(
      { theme: 'keep-this-preference' },
      { mergeFields: ['theme'] },
    );
  } finally {
    await firestore.terminate();
  }
}
export async function readSnoozePreferences(userId = 'e2e-agent-lcars-admin') {
  const firestore = client();
  try {
    return (await document(firestore, userId).get()).data();
  } finally {
    await firestore.terminate();
  }
}
export async function expireSnoozeFixture(anchor: string) {
  const firestore = client();
  try {
    await document(firestore, 'e2e-agent-lcars-admin').update(
      new FieldPath('decisionSnoozes', anchor, 'expiresAt'),
      new Date(Date.now() - 1000).toISOString(),
    );
  } finally {
    await firestore.terminate();
  }
}
