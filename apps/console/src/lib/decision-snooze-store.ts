import 'server-only';

import { createHash } from 'node:crypto';

import { required } from '@agent-lcars/util-server';
import { Firestore } from '@google-cloud/firestore';

import {
  activeDecisionSnoozes,
  type DecisionSnoozeAnchor,
  type DecisionSnoozes,
  MAX_DECISION_SNOOZES,
} from './decision-snooze-contract';

/** Preferences use the existing application-writable dispatch database, not
 * the read-only telemetry database. No Work, Run, or GitHub state is touched. */
export class DecisionSnoozeStore {
  constructor(private readonly firestore: Firestore) {}

  private document(userId: string) {
    if (!userId) throw new Error('Authenticated maintainer identity required');
    const id = createHash('sha256').update(`github:${userId}`).digest('hex');
    return this.firestore.collection('console-maintainer-preferences').doc(id);
  }

  async read(userId: string): Promise<DecisionSnoozes> {
    const snapshot = await this.document(userId).get();
    return activeDecisionSnoozes(
      snapshot.data()?.['decisionSnoozes'],
      Date.now(),
    );
  }

  async change(
    userId: string,
    anchors: DecisionSnoozeAnchor[],
    minutes?: number,
  ): Promise<DecisionSnoozes> {
    const ref = this.document(userId);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const now = Date.now();
      const entries = activeDecisionSnoozes(
        snapshot.data()?.['decisionSnoozes'],
        now,
      );
      for (const { anchor, signature } of anchors) {
        if (minutes === undefined) {
          // A device may still show the decision it saw before another device
          // snoozed new activity on this anchor. Remove only that observation.
          if (entries[anchor]?.signature === signature) delete entries[anchor];
        } else
          entries[anchor] = {
            signature,
            snoozedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + minutes * 60_000).toISOString(),
          };
      }
      if (Object.keys(entries).length > MAX_DECISION_SNOOZES)
        throw new Error('Snooze limit reached. Unsnooze an item first.');
      // Replace this field, not recursively merge its keys: otherwise deleting
      // an anchor would leave the old snooze behind. Preserve all other prefs.
      transaction.set(
        ref,
        { decisionSnoozes: entries },
        { mergeFields: ['decisionSnoozes'] },
      );
      return entries;
    });
  }
}

let store: DecisionSnoozeStore | undefined;
export function getDecisionSnoozeStore(): DecisionSnoozeStore {
  return (store ??= new DecisionSnoozeStore(
    new Firestore({
      projectId: required('PROJECT_ID'),
      databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
    }),
  ));
}
