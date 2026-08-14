import type { TaskAuthorityLease, WriteResult } from './authority-storage';
import type { TaskIntentState } from './task-intent-reducer';

type Hydrator = (input: {
  lease: TaskAuthorityLease;
  expectedRevision: number;
  next: TaskIntentState;
}) => Promise<WriteResult>;

const hydraters = new WeakMap<object, Hydrator>();

/** Internal test fixture hook. It is intentionally absent from the barrel. */
export function registerTaskTestHydrator(
  storage: object,
  hydrate: Hydrator,
): void {
  hydraters.set(storage, hydrate);
}

export async function hydrateTaskForTest(
  storage: object,
  input: Parameters<Hydrator>[0],
): Promise<WriteResult> {
  const hydrate = hydraters.get(storage);
  if (hydrate === undefined)
    throw new Error('Storage adapter has no test hydration hook');
  return hydrate(input);
}
