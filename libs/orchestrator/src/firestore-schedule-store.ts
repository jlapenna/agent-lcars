import {
  type CollectionReference,
  type DocumentReference,
  Firestore,
  type QueryDocumentSnapshot,
} from '@google-cloud/firestore';

import {
  type Schedule,
  scheduleSchema,
  type ScheduleStore,
} from './schedule-store';

export interface FirestoreScheduleStoreOptions {
  readonly projectId: string;
  readonly databaseId: string;
  /** Defaults to `orchestrator-`, matching `FirestoreStore` -- the
   *  collection is `<prefix>schedules`, alongside `<prefix>tasks`,
   *  `<prefix>runs`, `<prefix>outbox`. */
  readonly collectionPrefix?: string;
  readonly emulatorHost?: string;
}

export class FirestoreScheduleStore implements ScheduleStore {
  readonly #firestore: Firestore;
  readonly #schedules: CollectionReference;

  constructor(options: FirestoreScheduleStoreOptions) {
    const prefix = options.collectionPrefix ?? 'orchestrator-';
    this.#firestore = new Firestore({
      projectId: options.projectId,
      databaseId: options.databaseId,
      ...(options.emulatorHost === undefined
        ? {}
        : { host: options.emulatorHost, ssl: false }),
    });
    this.#schedules = this.#firestore.collection(`${prefix}schedules`);
  }

  async readSchedule(scheduleId: string): Promise<Schedule | undefined> {
    const snapshot = await this.#ref(scheduleId).get();
    return snapshot.exists ? scheduleSchema.parse(snapshot.data()) : undefined;
  }

  async mutateSchedule(
    scheduleId: string,
    change: (current: Schedule | undefined) => Schedule | undefined,
  ): Promise<Schedule | undefined> {
    const ref = this.#ref(scheduleId);
    return this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.exists
        ? scheduleSchema.parse(snapshot.data())
        : undefined;
      const next = change(current);
      if (next !== undefined) transaction.set(ref, scheduleSchema.parse(next));
      return next;
    });
  }

  async writeSchedule(schedule: Schedule): Promise<void> {
    await this.#ref(schedule.scheduleId).set(schedule);
  }

  async listSchedules(limit?: number): Promise<Schedule[]> {
    // Tombstones have no null sentinel in historical documents. Page the
    // existing single-field order until the requested visible count is full.
    const wanted = limit ?? 200;
    const rows: Schedule[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    while (rows.length < wanted) {
      let query = this.#schedules.orderBy('scheduleId', 'desc').limit(wanted);
      if (cursor !== undefined) query = query.startAfter(cursor);
      const snapshot = await query.get();
      for (const doc of snapshot.docs) {
        const schedule = scheduleSchema.parse(doc.data());
        if (schedule.deletedAt === undefined) rows.push(schedule);
      }
      if (snapshot.docs.length < wanted) break;
      cursor = snapshot.docs.at(-1);
    }
    return rows.slice(0, wanted);
  }

  async listEnabledSchedules(): Promise<Schedule[]> {
    const snapshot = await this.#schedules.where('enabled', '==', true).get();
    return snapshot.docs
      .map((doc) => scheduleSchema.parse(doc.data()))
      .filter((s) => s.deletedAt === undefined);
  }

  async listTickSchedules(): Promise<Schedule[]> {
    const [enabled, pending] = await Promise.all([
      this.listEnabledSchedules(),
      this.#schedules.where('pendingTick', '!=', null).get(),
    ]);
    const schedules = new Map(enabled.map((s) => [s.scheduleId, s]));
    for (const doc of pending.docs) {
      const schedule = scheduleSchema.parse(doc.data());
      schedules.set(schedule.scheduleId, schedule);
    }
    return [...schedules.values()];
  }

  #ref(scheduleId: string): DocumentReference {
    return this.#schedules.doc(encodeURIComponent(scheduleId));
  }
}
