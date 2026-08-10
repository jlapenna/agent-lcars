import { InMemoryRecoveryOperationPort } from './recovery-in-memory-port';
import { runRecoveryOperationPortContractSuite } from './recovery-port.contract';

runRecoveryOperationPortContractSuite(
  () => new InMemoryRecoveryOperationPort(),
);
