import { InMemoryLifecycleAuthorityStorage } from './authority-storage';
import { runLifecycleAuthorityStorageContract } from './authority-storage.spec.support';

runLifecycleAuthorityStorageContract(
  (clock) => new InMemoryLifecycleAuthorityStorage(clock),
);
