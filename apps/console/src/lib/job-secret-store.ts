import 'server-only';

import { type JobSecretRecord, jobSecretRecordSchema } from '@agent-lcars/work';
import { FieldValue, Firestore, Timestamp } from '@google-cloud/firestore';

export type JobSecretCollection = 'secrets' | 'sets' | 'grants' | 'health';
export interface JobSecretStore {
  get(collection: JobSecretCollection, id: string): Promise<unknown>;
  list(collection: JobSecretCollection): Promise<unknown[]>;
  put(
    collection: JobSecretCollection,
    id: string,
    value: unknown,
    createOnly?: boolean,
  ): Promise<void>;
  audit(event: Record<string, string>): Promise<void>;
  mutateSecret(
    name: string,
    change: (current: JobSecretRecord) => JobSecretRecord,
  ): Promise<JobSecretRecord>;
}
export class FirestoreJobSecretStore implements JobSecretStore {
  constructor(private readonly database: Firestore) {}
  private collection(kind: JobSecretCollection) {
    return this.database.collection(`job-credential-${kind}`);
  }
  private decode(
    kind: JobSecretCollection,
    value: Record<string, unknown> | undefined,
  ) {
    if (!value) return value;
    const fields =
      kind === 'health'
        ? ['lastDeliveryAt', 'lastRefusalAt']
        : kind === 'secrets'
          ? ['lastUsedAt']
          : [];
    for (const field of fields) {
      const clock = value[field];
      if (clock instanceof Timestamp)
        value[field] = clock.toDate().toISOString();
    }
    return value;
  }
  async get(kind: JobSecretCollection, id: string) {
    const doc = await this.collection(kind).doc(id).get();
    return doc.exists ? this.decode(kind, doc.data()) : undefined;
  }
  async list(kind: JobSecretCollection) {
    const result = await this.collection(kind).limit(501).get();
    if (result.size > 500)
      throw new Error('Credential registry exceeds supported bound');
    return result.docs.map((doc) => this.decode(kind, doc.data()));
  }
  async put(
    kind: JobSecretCollection,
    id: string,
    value: unknown,
    createOnly = false,
  ) {
    const ref = this.collection(kind).doc(id);
    if (createOnly) await ref.create(value as Record<string, unknown>);
    else await ref.set(value as Record<string, unknown>);
  }
  async audit(event: Record<string, string>) {
    const batch = this.database.batch();
    batch.create(this.database.collection('job-credential-audit').doc(), event);
    const counters: Record<string, string | undefined> = {
      'delivery-completed': 'deliveries',
      'admission-refused': 'admissionRefusals',
      'delivery-refused': 'deliveryRefusals',
    };
    const counter = counters[event.operation ?? ''];
    if (counter) {
      const duration = Number(event.durationSeconds);
      batch.set(
        this.collection('health').doc('current'),
        {
          [counter]: FieldValue.increment(1),
          ...(counter === 'deliveries'
            ? { lastDeliveryAt: FieldValue.serverTimestamp() }
            : {}),
          ...(counter !== 'deliveries'
            ? { lastRefusalAt: FieldValue.serverTimestamp() }
            : {}),
          ...(counter === 'deliveries' &&
          Number.isFinite(duration) &&
          duration >= 0
            ? {
                deliveryTimed: FieldValue.increment(1),
                deliveryDurationSeconds: FieldValue.increment(duration),
              }
            : {}),
        },
        { merge: true },
      );
    }
    if (event.operation?.startsWith('deliver') && event.secret)
      batch.update(this.collection('secrets').doc(event.secret), {
        lastUsedAt: FieldValue.serverTimestamp(),
      });
    await batch.commit();
  }
  async mutateSecret(
    name: string,
    change: (current: JobSecretRecord) => JobSecretRecord,
  ) {
    const ref = this.collection('secrets').doc(name);
    return this.database.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const current = jobSecretRecordSchema.parse(
        this.decode('secrets', snapshot.data()),
      );
      if (current.name !== name)
        throw new Error('Secret registry name mismatch');
      const next = jobSecretRecordSchema.parse(change(current));
      transaction.set(ref, next);
      return next;
    });
  }
}
