import { logger } from '@agent-lcars/logging';

import { WatcherConfig } from './config';
import {
  createFirestoreStore,
  createLogOnlyStore,
  SessionStore,
} from './store';

/** The subset of `WatcherConfig` that determines which store to build —
 * narrowed (rather than requiring the full host-watcher config) so runner
 * mode's `RunnerConfig` (which has no `shareDir`/`allowlist` concept) can
 * pass itself straight through without a throwaway host-watcher shape. */
export type StoreConfig = Pick<
  WatcherConfig,
  'firestoreEmulatorHost' | 'firestoreProjectId' | 'firestoreWriterKeyJson'
>;

/**
 * Picks the real Firestore store when writer credentials, an emulator, or
 * ambient Application Default Credentials are configured, otherwise falls
 * back to a log-only store — this is what lets `docker run` demonstrate the
 * daemon end-to-end without live GCP access (issue #2540's CI-only
 * verification scope).
 */
export function createStoreFromConfig(config: StoreConfig): SessionStore {
  if (config.firestoreEmulatorHost) {
    logger.info(
      `agent-lcars-telemetry-watcher: using Firestore emulator at ${config.firestoreEmulatorHost}`,
    );
    return createFirestoreStore({
      projectId: config.firestoreProjectId ?? 'demo-agent-telemetry',
      emulatorHost: config.firestoreEmulatorHost,
    });
  }

  if (config.firestoreProjectId && config.firestoreWriterKeyJson) {
    const credentials = JSON.parse(config.firestoreWriterKeyJson) as {
      client_email: string;
      private_key: string;
    };
    return createFirestoreStore({
      projectId: config.firestoreProjectId,
      credentials,
    });
  }

  if (config.firestoreProjectId) {
    // Runner mode receives a short-lived telemetry-writer credential through
    // GOOGLE_APPLICATION_CREDENTIALS for the sidecar process only. No writer
    // key JSON is involved: @google-cloud/firestore resolves that environment
    // variable as Application Default Credentials when no explicit
    // `credentials` option is passed.
    logger.info(
      `agent-lcars-telemetry-watcher: using ambient Application Default Credentials for project ${config.firestoreProjectId}`,
    );
    return createFirestoreStore({ projectId: config.firestoreProjectId });
  }

  logger.warn(
    'agent-lcars-telemetry-watcher: AGENT_TELEMETRY_PROJECT_ID/AGENT_TELEMETRY_WRITER_KEY_JSON not set; falling back to a log-only store',
  );
  return createLogOnlyStore();
}
