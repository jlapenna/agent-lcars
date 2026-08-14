import type { AttemptState } from './attempt-reducer';
import type { TaskAuthorityLease, WriteResult } from './authority-storage';

type Hydrator = (input: {
  lease: TaskAuthorityLease;
  expectedRevision: number;
  next: AttemptState;
}) => WriteResult;

const hydraters = new WeakMap<object, Hydrator>();

/** Internal test-only support; intentionally absent from the public barrel. */
export function registerAttemptTestHydrator(
  storage: object,
  hydrate: Hydrator,
): void {
  hydraters.set(storage, hydrate);
}

export async function hydrateAttemptForTest(
  storage: object,
  input: Parameters<Hydrator>[0],
): Promise<WriteResult> {
  const hydrate = hydraters.get(storage);
  if (hydrate === undefined)
    throw new Error('Storage adapter has no test hydration hook');
  return hydrate(input);
}
