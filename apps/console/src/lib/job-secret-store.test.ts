import { FieldValue, type Firestore } from '@google-cloud/firestore';
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
  expect(values.lastDeliveryAt).toBe(at);
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
