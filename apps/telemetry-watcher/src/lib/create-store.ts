import { logger } from '@repo/logging';

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
    // Runner mode (issue #3107 follow-up 5): claude.yml's "Start telemetry
    // ride-along" step mints a short-lived credentials file for the
    // agent-telemetry-writer SA via WIF (google-github-actions/auth) and
    // points GOOGLE_APPLICATION_CREDENTIALS at it for the ride-along
    // process's own env only — never job-wide (see claude.yml's
    // "Authenticate telemetry writer" step comment for why the ordering of
    // that step relative to the readonly "Authenticate to GCP" step
    // matters). No writer key JSON is involved: @google-cloud/firestore's
    // client resolves that env var as Application Default Credentials
    // automatically when no explicit `credentials` option is passed.
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
