import { InMemoryLifecycleAuthorityStorage } from './authority-storage';
import { runLaunchResolutionStorageContract } from './launch-resolution.spec.support';

runLaunchResolutionStorageContract({
  create: (clock) => new InMemoryLifecycleAuthorityStorage(clock),
});
