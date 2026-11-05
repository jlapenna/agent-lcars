import { FieldValue, type Firestore, Timestamp } from '@google-cloud/firestore';
import { expect, it, vi } from 'vitest';

import { FirestoreJobSecretStore } from './job-secret-store';

it('commits audit and independent durable counter increments atomically without overwriting another counter', async () => {
  const batch = {
    create: vi.fn(),
    set: vi.fn(),
    update: vi.fn(),
    commit: vi.fn(async () => undefined),
  };
  const database = {
    batch: () => batch,
    collection: (kind: string) => ({
      doc: (id = 'audit-id') => ({ path: `${kind}/${id}` }),
    }),
  } as unknown as Firestore;
  const store = new FirestoreJobSecretStore(database);
  const at = '2026-11-05T00:00:00Z';
  await store.audit({ actor: 'user:joe', operation: 'delivery-completed', at });
  expect(batch.commit).toHaveBeenCalledTimes(1);
  expect(batch.create).toHaveBeenCalledTimes(1);
  const [ref, values, options] = batch.set.mock.calls[0]!;
  expect(ref).toEqual({ path: 'job-credential-health/current' });
  expect(values.deliveries.isEqual(FieldValue.increment(1))).toBe(true);
  expect(values.lastDeliveryAt.isEqual(FieldValue.serverTimestamp())).toBe(
    true,
  );
  expect(options).toEqual({ merge: true });
  await store.audit({ actor: 'user:joe', operation: 'admission-refused', at });
  expect(batch.commit).toHaveBeenCalledTimes(2);
  const refused = batch.set.mock.calls[1]!;
  expect(Object.keys(refused[1])).toEqual([
    'admissionRefusals',
    'lastRefusalAt',
  ]);
  expect(refused[1].admissionRefusals.isEqual(FieldValue.increment(1))).toBe(
    true,
  );
  expect(refused[2]).toEqual({ merge: true });
});

it('uses commit clocks under reversed writes and normalizes them for every metadata reader', async () => {
  const rows = new Map<string, Record<string, unknown>>();
  const pending: Array<(clock: Date) => void> = [];
  let auditId = 0;
  const ref = (path: string) => ({
    path,
    get: async () => ({
      exists: rows.has(path),
      data: () => ({ ...rows.get(path) }),
    }),
  });
  const database = {
    collection: (kind: string) => ({
      doc: (id = String(auditId++)) => ref(`${kind}/${id}`),
      limit: () => ({
        get: async () => ({
          size: rows.size,
          docs: [...rows]
            .filter(([path]) => path.startsWith(`${kind}/`))
            .map(([, value]) => ({ data: () => ({ ...value }) })),
        }),
      }),
    }),
    batch: () => {
      const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
      const write = (
        reference: { path: string },
        data: Record<string, unknown>,
      ) => {
        writes.push({ path: reference.path, data });
      };
      return {
        create: write,
        set: write,
        update: write,
        commit: () =>
          new Promise<void>((resolve) => {
            pending.push((clock) => {
              for (const { path, data } of writes) {
                const row = { ...rows.get(path) };
                for (const [key, value] of Object.entries(data)) {
                  row[key] =
                    value instanceof FieldValue &&
                    value.isEqual(FieldValue.serverTimestamp())
                      ? Timestamp.fromDate(clock)
                      : value instanceof FieldValue &&
                          value.isEqual(FieldValue.increment(1))
                        ? Number(row[key] ?? 0) + 1
                        : value;
                }
                rows.set(path, row);
              }
              resolve();
            });
          }),
      };
    },
    runTransaction: async (change: (tx: unknown) => Promise<unknown>) =>
      change({
        get: (reference: { path: string }) => ref(reference.path).get(),
        set: (reference: { path: string }, data: Record<string, unknown>) =>
          rows.set(reference.path, data),
      }),
  } as unknown as Firestore;
  const store = new FirestoreJobSecretStore(database);
  const older = '2026-11-05T00:00:00Z';
  const newer = '2026-11-05T00:01:00Z';
  const first = store.audit({
    actor: 'user:joe',
    operation: 'admission-refused',
    at: older,
  });
  const second = store.audit({
    actor: 'user:joe',
    operation: 'admission-refused',
    at: newer,
  });
  pending[1]!(new Date('2026-11-05T00:02:00Z'));
  await second;
  pending[0]!(new Date('2026-11-05T00:03:00Z'));
  await first;
  expect(await store.get('health', 'current')).toEqual({
    admissionRefusals: 2,
    lastRefusalAt: '2026-11-05T00:03:00.000Z',
  });
  expect(
    [...rows.values()]
      .filter((row) => row.operation === 'admission-refused')
      .map((row) => row.at)
      .sort(),
  ).toEqual([older, newer]);
  const laterCommit = [...rows.values()].find(
    (row) => row.operation === 'admission-refused' && row.at === older,
  );
  expect((laterCommit?.recordedAt as Timestamp).toDate().toISOString()).toBe(
    '2026-11-05T00:03:00.000Z',
  );
  rows.set('job-credential-secrets/example-key', {
    name: 'example-key',
    kind: 'opaque',
    enabled: true,
    updatedAt: older,
    updatedBy: 'user:joe',
  });
  const used = store.audit({
    actor: 'user:joe',
    operation: 'deliver',
    at: older,
    secret: 'example-key',
  });
  pending[2]!(new Date('2026-11-05T00:04:00Z'));
  await used;
  expect(await store.get('secrets', 'example-key')).toMatchObject({
    lastUsedAt: '2026-11-05T00:04:00.000Z',
  });
  expect(await store.list('secrets')).toEqual([
    expect.objectContaining({ lastUsedAt: '2026-11-05T00:04:00.000Z' }),
  ]);
  expect(
    await store.mutateSecret('example-key', (current) => ({
      ...current,
      enabled: false,
    })),
  ).toMatchObject({ enabled: false, lastUsedAt: '2026-11-05T00:04:00.000Z' });
});
