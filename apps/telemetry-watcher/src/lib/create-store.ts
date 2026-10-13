import { logger } from '@agent-lcars/logging';

import { SharedWatcherConfig } from './config';
import {
  createFirestoreStore,
  createLogOnlyStore,
  type FirestoreStoreOptions,
  SessionStore,
} from './store';

/** The subset of the shared config that determines which store to build;
 * runner mode's `RunnerConfig` passes itself straight through. */
export type StoreConfig = Pick<
  SharedWatcherConfig,
  'firestoreEmulatorHost' | 'firestoreProjectId' | 'firestoreWriterKeyJson'
>;

/** Resolves the one supported telemetry Firestore configuration. */
export function firestoreStoreOptions(
  config: StoreConfig,
): FirestoreStoreOptions | undefined {
  if (config.firestoreEmulatorHost) {
    return {
      projectId: config.firestoreProjectId ?? 'demo-agent-telemetry',
      emulatorHost: config.firestoreEmulatorHost,
    };
  }

  if (config.firestoreProjectId && config.firestoreWriterKeyJson) {
    return {
      projectId: config.firestoreProjectId,
      credentials: JSON.parse(config.firestoreWriterKeyJson) as {
        client_email: string;
        private_key: string;
      },
    };
  }

  return config.firestoreProjectId === undefined
    ? undefined
    : { projectId: config.firestoreProjectId };
}

/**
 * Picks the real Firestore store when writer credentials, an emulator, or
 * ambient Application Default Credentials are configured, otherwise falls
 * back to a log-only store — which is what lets the standalone bundle smoke
 * test (`tools/telemetry-watcher-standalone-smoke.sh`) run `runner finalize`
 * end-to-end without live GCP access.
 */
export function createStoreFromConfig(config: StoreConfig): SessionStore {
  const options = firestoreStoreOptions(config);
  if (config.firestoreEmulatorHost && options !== undefined) {
    logger.info(
      `agent-lcars-telemetry-watcher: using Firestore emulator at ${config.firestoreEmulatorHost}`,
    );
    return createFirestoreStore(options);
  }

  if (options !== undefined) {
    // Runner mode receives a short-lived telemetry-writer credential through
    // GOOGLE_APPLICATION_CREDENTIALS for the sidecar process only. No writer
    // key JSON is involved: @google-cloud/firestore resolves that environment
    // variable as Application Default Credentials when no explicit
    // `credentials` option is passed.
    logger.info(
      `agent-lcars-telemetry-watcher: using ambient Application Default Credentials for project ${config.firestoreProjectId}`,
    );
    return createFirestoreStore(options);
  }

  logger.warn(
    'agent-lcars-telemetry-watcher: AGENT_TELEMETRY_PROJECT_ID/AGENT_TELEMETRY_WRITER_KEY_JSON not set; falling back to a log-only store',
  );
  return createLogOnlyStore();
}
