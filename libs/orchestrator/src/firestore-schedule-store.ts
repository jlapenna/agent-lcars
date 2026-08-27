import {
  type CollectionReference,
  type DocumentReference,
  Firestore,
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

  async writeSchedule(schedule: Schedule): Promise<void> {
    await this.#ref(schedule.scheduleId).set(schedule);
  }

  async listSchedules(limit?: number): Promise<Schedule[]> {
    const snapshot = await this.#schedules
      .orderBy('scheduleId', 'desc')
      .limit(limit ?? 200)
      .get();
    return snapshot.docs.map((doc) => scheduleSchema.parse(doc.data()));
  }

  async listEnabledSchedules(): Promise<Schedule[]> {
    const snapshot = await this.#schedules.where('enabled', '==', true).get();
    return snapshot.docs.map((doc) => scheduleSchema.parse(doc.data()));
  }

  #ref(scheduleId: string): DocumentReference {
    return this.#schedules.doc(encodeURIComponent(scheduleId));
  }
}
