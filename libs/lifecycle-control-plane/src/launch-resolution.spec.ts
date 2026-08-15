import { InMemoryLifecycleAuthorityStorage } from './authority-storage';
import {
  runLaunchResolutionHistoryStorageContract,
  runLaunchResolutionStorageContract,
} from './launch-resolution.spec.support';
import { inMemoryLaunchResolutionHistoryStorageHooks } from './launch-resolution-history.in-memory.spec.support';

runLaunchResolutionStorageContract({
  create: (clock) => new InMemoryLifecycleAuthorityStorage(clock),
});

runLaunchResolutionHistoryStorageContract({
  create: (clock) => new InMemoryLifecycleAuthorityStorage(clock),
  historyHooks: inMemoryLaunchResolutionHistoryStorageHooks(),
});
