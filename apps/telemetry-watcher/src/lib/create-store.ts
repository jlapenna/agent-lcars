import { logger } from '@agent-lcars/logging';

import { WatcherConfig } from './config';
import {
  createFirestoreStore,
  createLogOnlyStore,
  type FirestoreStoreOptions,
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

/** Resolves the one supported telemetry Firestore configuration.  The
 * one-shot schema-backfill operator tool consumes this too, so its emulator
 * behavior cannot drift from the normal watcher store. */
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
 * back to a log-only store — this is what lets `docker run` demonstrate the
 * daemon end-to-end without live GCP access (issue #2540's CI-only
 * verification scope).
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
