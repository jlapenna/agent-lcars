import 'server-only';

import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import { parseSessionDoc } from '@agent-lcars/telemetry';
import { required } from '@agent-lcars/util-server';
import { Firestore, Timestamp } from '@google-cloud/firestore';

import type { ArchiveSnapshot } from './session-archive-sync';

/**
 * The console's saved view of the session archive window, so an instance
 * that has not read the window yet starts from it instead of the session
 * store's ~6,500 documents (about 2 s). The 14-day window compresses from
 * 8.5 MB of JSON to about 1 MB of gzip.
 *
 * Kept in the application-writable dispatch database, not the read-only
 * telemetry database, like the maintainer preferences in
 * decision-snooze-store.ts. A fixed set of slot documents is written in one
 * batch and read back in one read-only transaction, so a reader never
 * combines chunks from two saves.
 */
export const SNAPSHOT_COLLECTION = 'console-session-archive';
const MANIFEST_ID = 'manifest';
const SNAPSHOT_VERSION = 1;
/** Under Firestore's 1 MiB document limit, with room for the other fields. */
const CHUNK_BYTES = 900_000;
/** 7.2 MB of gzip: several times today's window, under the 10 MiB batch. */
const SLOTS = 8;

const slotId = (index: number) => `chunk-${index}`;

export interface EncodedSnapshot {
  chunks: Buffer[];
  sessions: number;
}

export function encodeSnapshotDocs(
  docs: ArchiveSnapshot['docs'],
): EncodedSnapshot {
  const gzip = gzipSync(JSON.stringify(docs));
  const chunks: Buffer[] = [];
  for (let start = 0; start < gzip.length; start += CHUNK_BYTES)
    chunks.push(gzip.subarray(start, start + CHUNK_BYTES));
  return { chunks, sessions: docs.length };
}

export function decodeSnapshotDocs(
  chunks: readonly Buffer[],
): ArchiveSnapshot['docs'] {
  const parsed: unknown = JSON.parse(
    gunzipSync(Buffer.concat(chunks)).toString('utf8'),
  );
  if (!Array.isArray(parsed)) throw new Error('Snapshot is not a list');
  return parsed.map((doc) => parseSessionDoc(doc));
}

export async function saveArchiveSnapshot(
  firestore: Firestore,
  snapshot: ArchiveSnapshot,
): Promise<void> {
  const { chunks, sessions } = encodeSnapshotDocs(snapshot.docs);
  if (chunks.length > SLOTS)
    throw new Error(
      `Snapshot needs ${chunks.length} chunks; ${SLOTS} slots are available`,
    );
  const collection = firestore.collection(SNAPSHOT_COLLECTION);
  const generation = randomUUID();
  const batch = firestore.batch();
  batch.set(collection.doc(MANIFEST_ID), {
    version: SNAPSHOT_VERSION,
    generation,
    chunks: chunks.length,
    sessions,
    writtenSince: snapshot.writtenSince,
    syncedAt: Timestamp.fromMillis(snapshot.syncedAt),
  });
  for (let index = 0; index < SLOTS; index++) {
    const ref = collection.doc(slotId(index));
    const chunk = chunks[index];
    if (chunk) batch.set(ref, { generation, data: chunk });
    else batch.delete(ref);
  }
  await batch.commit();
}

export async function loadArchiveSnapshot(
  firestore: Firestore,
): Promise<ArchiveSnapshot | undefined> {
  const collection = firestore.collection(SNAPSHOT_COLLECTION);
  const refs = [
    collection.doc(MANIFEST_ID),
    ...Array.from({ length: SLOTS }, (_, index) =>
      collection.doc(slotId(index)),
    ),
  ];
  const [manifest, ...slots] = await firestore.runTransaction(
    (transaction) => transaction.getAll(...refs),
    { readOnly: true },
  );
  const fields = manifest?.data();
  if (!fields || fields['version'] !== SNAPSHOT_VERSION) return undefined;
  const count = fields['chunks'];
  const writtenSince = fields['writtenSince'];
  const syncedAt = fields['syncedAt'];
  if (
    typeof count !== 'number' ||
    count < 1 ||
    count > SLOTS ||
    !(writtenSince instanceof Timestamp) ||
    !(syncedAt instanceof Timestamp)
  )
    throw new Error('Snapshot manifest is malformed');
  const chunks = slots.slice(0, count).map((slot) => {
    const data = slot.data();
    if (!data || data['generation'] !== fields['generation'])
      throw new Error('Snapshot chunks do not match the manifest');
    const bytes: unknown = data['data'];
    // The Node SDK returns Firestore bytes as a Buffer.
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array))
      throw new Error('Snapshot chunk holds no bytes');
    return Buffer.from(bytes);
  });
  return {
    docs: decodeSnapshotDocs(chunks),
    writtenSince,
    syncedAt: syncedAt.toMillis(),
  };
}

let snapshotFirestore: Firestore | undefined;
export function getArchiveSnapshotFirestore(): Firestore {
  return (snapshotFirestore ??= new Firestore({
    projectId: required('PROJECT_ID'),
    databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
  }));
}
