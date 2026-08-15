import { InMemoryLifecycleAuthorityStorage } from './authority-storage';
import { inMemoryPresentationDeliveryStorageHooks } from './presentation-delivery.in-memory.spec.support';
import { runPresentationDeliveryStorageContract } from './presentation-delivery.spec.support';

runPresentationDeliveryStorageContract({
  create: (clock) => new InMemoryLifecycleAuthorityStorage(clock),
  ...inMemoryPresentationDeliveryStorageHooks,
});
