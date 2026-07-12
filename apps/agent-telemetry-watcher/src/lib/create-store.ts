import { logger } from '@repo/logging';

import { WatcherConfig } from './config';
import {
  createFirestoreStore,
  createLogOnlyStore,
  SessionStore,
} from './store';

/**
 * Picks the real Firestore store when writer credentials (or an emulator)
 * are configured, otherwise falls back to a log-only store — this is what
 * lets `docker run` demonstrate the daemon end-to-end without live GCP
 * access (issue #2540's CI-only verification scope).
 */
export function createStoreFromConfig(config: WatcherConfig): SessionStore {
  if (config.firestoreEmulatorHost) {
    logger.info(
      `agent-telemetry-watcher: using Firestore emulator at ${config.firestoreEmulatorHost}`,
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

  logger.warn(
    'agent-telemetry-watcher: AGENT_TELEMETRY_PROJECT_ID/AGENT_TELEMETRY_WRITER_KEY_JSON not set; falling back to a log-only store',
  );
  return createLogOnlyStore();
}
