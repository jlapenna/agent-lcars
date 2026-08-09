import type {
  ReconcileScanResult,
  ReconcileTransport,
} from '@agent-lcars/dispatch-reconcile';

export interface ReconciliationInput {
  repository: string;
  fleetLogin: string;
}

export interface ReconciliationDependencies {
  transport: ReconcileTransport;
  run(
    transport: ReconcileTransport,
    repository: string,
    fleetLogin: string,
  ): Promise<ReconcileScanResult>;
  writeOutput(name: string, value: string): Promise<void>;
  log(message: string): void;
}

export async function orchestrateReconciliation(
  input: ReconciliationInput,
  dependencies: ReconciliationDependencies,
): Promise<ReconcileScanResult> {
  const results = await dependencies.run(
    dependencies.transport,
    input.repository,
    input.fleetLogin,
  );
  dependencies.log(
    `::notice::dispatch-reconcile: fired reconcile for ${results.dispatched}/` +
      `${results.candidates} candidate(s) (${results.openCandidates} open ` +
      `agent-labeled/fleet-assigned, ${results.closedCandidates} recently-closed ` +
      `agent-labeled/fleet-assigned).`,
  );
  for (const failure of results.failed) {
    dependencies.log(
      `::error::dispatch-reconcile: failed to dispatch reconcile for ` +
        `#${failure.issue}: ${failure.message}`,
    );
  }
  await dependencies.writeOutput('candidates', String(results.candidates));
  await dependencies.writeOutput('dispatched', String(results.dispatched));
  if (results.failed.length > 0) {
    throw new Error(
      `Reconcile scan failed to dispatch ${results.failed.length}/` +
        `${results.candidates} candidate(s): ` +
        results.failed.map((failure) => `#${failure.issue}`).join(', '),
    );
  }
  return results;
}
