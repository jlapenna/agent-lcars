import { InMemoryLifecycleAuthorityStorage } from './authority-storage';
import { runVerifiedRunBindingStorageContract } from './launch-binding.spec.support';

runVerifiedRunBindingStorageContract(
  () =>
    new InMemoryLifecycleAuthorityStorage({
      now: () => '2026-08-01T00:00:00.000Z',
    }),
);
