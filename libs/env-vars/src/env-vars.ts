export interface EnvVars {
  PROJECT_ID: string;
  NEXT_PUBLIC_PROJECT_ID: string;
  GCLOUD_PROJECT?: string;
  FIREBASE_PROJECT_ID?: string;
  NEXT_PUBLIC_FIREBASE_PROJECT_ID?: string;
  NEXT_PUBLIC_FIREBASE_API_KEY?: string;
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?: string;
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET?: string;
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID?: string;
  NEXT_PUBLIC_FIREBASE_APP_ID?: string;

  // Cloud Run
  K_SERVICE?: string;
  K_REVISION?: string;
  CLOUD_RUN_JOB?: string;

  // Standard
  NODE_ENV?: 'development' | 'production' | 'test';
  CI?: string;

  AUTH_ENABLED?: string;

  LOG_LEVEL?: string;
  SLACK_LOG_LEVEL?: string;

  SLACK_ADMINS?: string;

  AGENT_CONSOLE_GITHUB_API_BASE_URL?: string;
  AGENT_LCARS_ADMIN_GITHUB_LOGIN?: string;
  // Issue #1190: GitHub App credentials for minting per-repo installation
  // tokens (see apps/console/src/lib/github-app-tokens.ts). Both must be
  // set for the outbox drain to use the App path at all; either unset
  // falls back to the single ambient AGENT_LCARS_GITHUB_TOKEN for every
  // repo. Not yet wired to any deployment -- dormant until a follow-up
  // adds the private key as a Secret Manager value and apphosting.yaml env.
  AGENT_LCARS_APP_CLIENT_ID?: string; // Secret
  AGENT_LCARS_APP_PRIVATE_KEY?: string; // Secret
  AGENT_LCARS_ARTIFACT_SHARE_BASE_URL?: string;
  AGENT_LCARS_CONTROL_PLANE_REPOSITORY?: string;
  AGENT_LCARS_CONTROL_PLANE_REPOSITORIES?: string;
  AGENT_LCARS_FLEET_GITHUB_LOGIN?: string;
  AGENT_LCARS_GITHUB_TOKEN?: string; // Secret
  AGENT_LCARS_HOSTED_ADMISSION_MODE?: string;
  AGENT_LCARS_WEBHOOK_QUEUE?: string;
  AGENT_LCARS_WEBHOOK_QUEUE_LOCATION?: string;
  AGENT_LCARS_WEBHOOK_SECRET?: string; // Secret
  AGENT_LCARS_WATCHED_REPOS?: string;
  DISPATCH_FIRESTORE_DATABASE_ID?: string;
  QUICK_TASK_EVIDENCE_BUCKET?: string;

  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST?: string;
  NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST?: string;

  /** Server Secrets **/
  AUTH_SECRET?: string; // Secret
  AUTH_URL?: string;

  E2E_TESTING_USER?: string;
  E2E_TESTING?: string;

  PORT?: string;

  FORCE_STRUCTURED_LOGGING?: string;
  MAINTENANCE_MODE?: string;

  /** Local Development only. */

  /** Dev only */
  DEBUG?: string;
  /** Dev only */
  LOCAL?: string;
  /** Dev only */
  FUNCTIONS_EMULATOR?: string;
  /** Dev only */
  FIREBASE_AUTH_EMULATOR_HOST?: string;
  /** Dev only */
  FIRESTORE_EMULATOR_HOST?: string;
  /** Dev only */
  AUTH_EMULATOR_HOST?: string;
  /** Dev only */
  IMPERSONATE_AUTOMATIC_LOGIN?: string;

  // Agent telemetry host watcher (issue #2540). See
  // infra/terraform/main.tf for the dedicated Firestore database + writer
  // SA this daemon authenticates as.
  /** Legacy single-root compatibility alias for
   * `AGENT_TELEMETRY_CHECKOUT_ROOTS`. */
  AGENT_TELEMETRY_CHECKOUT_ROOT?: string;
  /** Required comma-separated checkout roots this host watcher may ship.
   * Every source's default privacy allowlist derives from this one value;
   * host mode deliberately has no built-in path fallback. */
  AGENT_TELEMETRY_CHECKOUT_ROOTS?: string;
  /** Root of `~/.claude/projects` to watch; overridable for tests/Docker fixture mounts.
   * Ignored once `AGENT_TELEMETRY_WATCH_ROOTS` is set - see that var's doc comment. */
  AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR?: string;
  /** Root of Codex's date-partitioned rollout JSONL tree. */
  AGENT_TELEMETRY_CODEX_SESSIONS_DIR?: string;
  /** Comma-separated cwd globs limiting which Codex sessions may ship. */
  AGENT_TELEMETRY_CODEX_CWD_ALLOWLIST?: string;
  /** Comma-separated `*`-wildcard glob patterns; defaults to the configured checkout's slug only.
   * Ignored once `AGENT_TELEMETRY_WATCH_ROOTS` is set - see that var's doc comment. */
  AGENT_TELEMETRY_PROJECT_DIR_ALLOWLIST?: string;
  /** JSON array of `{ path, adapter, projectDirAllowlist?, recursive?, cwdAllowlist? }` watch-root objects
   * (#3123 phase 1's multi-root/multi-agent watcher config) - when set, fully
   * replaces the single default root the two vars above configure. See
   * `apps/telemetry-watcher/src/lib/config.ts`'s `loadConfig` for the
   * exact format and validation. */
  AGENT_TELEMETRY_WATCH_ROOTS?: string;
  /** Overrides `os.hostname()` for the `host` field on shipped session docs. */
  AGENT_TELEMETRY_HOST?: string;
  /** GCP project the dedicated `agent-telemetry` Firestore database lives in. */
  AGENT_TELEMETRY_PROJECT_ID?: string;
  /** GCS bucket `runner finalize` (issue #24) archives session transcripts
   * to; defaults to `${AGENT_TELEMETRY_PROJECT_ID}-session-transcripts`. See
   * `apps/telemetry-watcher/src/lib/finalize.ts`. */
  AGENT_TELEMETRY_TRANSCRIPTS_BUCKET?: string;
  /** Raw JSON contents of the `AGENT_TELEMETRY_WRITER_KEY_JSON` GCP secret. */
  AGENT_TELEMETRY_WRITER_KEY_JSON?: string;
  /** Tick interval in milliseconds; defaults to 10s. */
  AGENT_TELEMETRY_HEARTBEAT_INTERVAL_MS?: string;
  /** Staleness window in milliseconds; defaults to 5x the heartbeat interval. */
  AGENT_TELEMETRY_STALENESS_WINDOW_MS?: string;
  /** Root of `~/share` (share-media skill convention) to scan for session artifacts; defaults to `~/share`. */
  AGENT_TELEMETRY_SHARE_DIR?: string;
  /** Address for the host watcher's Prometheus endpoint; defaults to `0.0.0.0`. */
  AGENT_TELEMETRY_METRICS_HOST?: string;
  /** Port for the host watcher's Prometheus endpoint; defaults to `9464`. */
  AGENT_TELEMETRY_METRICS_PORT?: string;
  /** Absolute path to Antigravity's global summary-tier SQLite DB
   * (`conversation_summaries.db`) - default-enabled at
   * `~/.gemini/antigravity-cli/conversation_summaries.db` when unset; an
   * explicit empty string disables this source entirely (e.g. a host with
   * no Antigravity CLI installed). See #3123 phase 3 and
   * `apps/telemetry-watcher/src/lib/antigravity-summary-source.ts`. */
  AGENT_TELEMETRY_ANTIGRAVITY_SUMMARY_DB?: string;
  /** Root of the local session-title overlay state (issue #1212) -
   * default-enabled at `~/.local/state/agent-lcars` when unset; an explicit
   * empty string disables the overlay entirely, matching
   * `AGENT_TELEMETRY_ANTIGRAVITY_SUMMARY_DB`'s convention above. Holds
   * `session-metadata/` (titles an agent declared via `lcars session title`)
   * and `native-titles/` (titles the host importer read out of Codex's own
   * thread store). See
   * `apps/telemetry-watcher/src/lib/session-title-paths.ts`. */
  AGENT_TELEMETRY_SESSION_STATE_DIR?: string;
  /** Absolute path to Codex's thread-store SQLite DB - defaults to the
   * highest-numbered `~/.codex/state_<N>.sqlite` when unset (the numeric
   * suffix is a schema version Codex rotates), and an explicit empty string
   * disables the native-title import. Read only by the HOST-side importer
   * (`lcars session import-native`), never by the watcher container: that
   * database is WAL-mode, and a WAL reader must be able to write its `-shm`
   * sidecar, so a read-only bind mount of it fails outright. See
   * `apps/telemetry-watcher/src/lib/codex-native-title-source.ts`. */
  AGENT_TELEMETRY_CODEX_STATE_DB?: string;
}
