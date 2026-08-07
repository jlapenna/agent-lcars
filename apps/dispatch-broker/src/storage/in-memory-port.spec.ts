/**
 * Proves `InMemoryStoragePort` against the shared `StoragePort` contract
 * (#645 Phase 5). All the actual assertions live in ./port.contract.ts,
 * written against the port interface -- this file only supplies a factory,
 * exactly the shape a future durable backend's own `<backend>.spec.ts`
 * would.
 */

import { InMemoryStoragePort } from './in-memory-port.js';
import { runStoragePortContractSuite } from './port.contract.js';

runStoragePortContractSuite(
  'InMemoryStoragePort',
  () => new InMemoryStoragePort(),
);
