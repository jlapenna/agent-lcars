import { InMemoryLifecycleAuthorityStorage } from './authority-storage';
import type { BindingHistoryStorageHooks } from './launch-binding.spec.support';
import { runVerifiedRunBindingStorageContract } from './launch-binding.spec.support';
import { inMemoryBindingHistoryHooks } from './launch-binding-history-test-support';

export const bindingHistoryHooks: BindingHistoryStorageHooks =
  inMemoryBindingHistoryHooks();

runVerifiedRunBindingStorageContract(
  () =>
    new InMemoryLifecycleAuthorityStorage({
      now: () => '2026-08-01T00:00:00.000Z',
    }),
  bindingHistoryHooks,
);
