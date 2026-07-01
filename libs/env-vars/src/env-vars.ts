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

  // AI
  GEMINI_API_KEY?: string;
  GOOGLE_API_KEY?: string;

  // Reasoner (provider-agnostic LLM disambiguation). See #1686 / #1675 §6.0.
  // Primary target is the self-hosted OpenAI-compatible endpoint; falls back to
  // googleai (gemini-3.5-flash) on timeout/error.
  LLM_PROVIDER?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_FALLBACK_MODEL?: string;

  // Canonical cross-provider matcher feature flags (#1675 §6). Default off.
  CANONICAL_MATCHER_ENABLED?: string;
  CANONICAL_AUTO_MERGE_ENABLED?: string;

  NEXT_PUBLIC_ANALYTICS_ID?: string;

  AUTH_ENABLED?: string;

  LOG_LEVEL?: string;
  SLACK_LOG_LEVEL?: string;
  STRAVA_LOG_LEVEL?: string;
  ENABLE_REQUEST_LOGGING?: string;
  ENABLE_FIRESTORE_REQUEST_LOGGING?: string;

  SLACK_QBP_STAFF_CHANNEL?: string;
  SLACK_QBP_ANNOUNCE_CHANNEL?: string;
  SLACK_APP_ID?: string;

  SLACK_TEAM_WORKSPACE_NAME: string;
  SLACK_DEBUG_CHANNEL: string;
  SLACK_LEADERBOARDS_CHANNEL: string;
  SLACK_RACES_CRON_CHANNEL: string;
  SLACK_MGMT_CHANNEL: string;
  SLACK_STAFF_CHANNEL: string;
  SLACK_STAFF_ADDITIONAL_CHANNELS_LIST?: string;
  SLACK_ANNOUNCE_CHANNEL?: string;
  SLACK_PSEUDOBOTS?: string;
  SLACK_ADMINS?: string;
  ONECAKE_ADMINS?: string;
  ADMIN_EMAILS?: string;

  SLACK_PROFILE_FIELD_STRAVA: string;
  SLACK_PROFILE_FIELD_INSTAGRAM: string;
  SLACK_PROFILE_FIELD_ROADRESULTS: string;
  SLACK_PROFILE_FIELD_CROSSRESULTS: string;
  SLACK_PROFILE_FIELD_GRAVELRESULTS: string;
  SLACK_PROFILE_FIELD_ATHLINKS: string;
  SLACK_PROFILE_FIELD_USAC: string;
  SLACK_PROFILE_FIELD_USAC_ROAD_CAT: string;
  SLACK_PROFILE_FIELD_USAC_CROSS_CAT: string;

  INSTAGRAM_WEBHOOK_VERIFY_TOKEN?: string; // Secret

  STAFF_MAILING_LIST: string;
  TEAM_MAILING_LIST: string;
  EXPORT_SPREADSHEET_ID: string;
  EXPORT_SPREADSHEET_WORKSHEET_TITLE: string;
  EFFORTS_SPREADSHEET_WORKSHEET_TITLE: string;
  EFFORTS_SPREADSHEET_ID: string;
  SEGMENTS_SPREADSHEET_ID: string;
  SEGMENTS_SPREADSHEET_WORKSHEET_TITLE: string;
  LOOKUP_SPREADSHEET_ID: string;
  LOOKUP_SPREADSHEET_SLACK_WORKSHEET_TITLE: string;
  LOOKUP_SPREADSHEET_EMAIL_WORKSHEET_TITLE: string;
  RESULTS_SPREADSHEET_ID: string;
  RESULTS_SPREADSHEET_WORKSHEET_TITLE: string;
  RACES_SPREADSHEET_ID: string;
  RACES_SPREADSHEET_WORKSHEET_TITLE: string;
  RACES_CALENDAR_ID: string;
  EVENTS_SPREADSHEET_ID: string;
  EVENTS_SPREADSHEET_WORKSHEET_TITLE: string;

  ROADRESULTS_TEAM_ID: string;
  CROSSRESULTS_TEAM_ID: string;
  GRAVELRESULTS_TEAM_ID: string;

  APPLICATION_2024_FORM_ID: string;
  APPLICATION_2025_FORM_ID: string;
  QBP_API_BASE_URL: string;
  QBP_API_KEY?: string;
  QBP_FORM_ID: string;
  QBP_FORM_METADATA: 'dev' | 'prod';
  QBP_RESPONSES_SPREADSHEET_ID: string;
  QBP_RESPONSES_WORKSHEET_TITLE: string;
  QBP_EFTP_HOST?: string;
  QBP_EFTP_PORT?: string;
  QBP_EFTP_LOGIN?: string; // Secret
  QBP_EFTP_PASSWORD?: string; // Secret
  QBP_EFTP_SHIP_TO_CODE?: string;
  QBP_EFTP_ACCOUNT_NUMBER?: string;

  SQUAREUP_ENVIRONMENT?: string;
  SQUAREUP_APPLICATION_ID?: string;
  SQUAREUP_LOCATION_ID?: string;
  SQUAREUP_SERVICE_CHARGE_ID?: string;
  SQUAREUP_ACCESS_TOKEN?: string; // Secret

  VERTEX_AI_LOCATION?: string;

  PROVIDER_MIN_REQUEST_DELAY_MS?: string;

  PROVIDER_REQUEST_TIMEOUT_MS?: string;

  PROVIDER_USER_AGENT?: string;

  BACKEND_SERVICE_URL?: string;
  AGENT_SERVICE_URL?: string;
  WEB_SERVICE_URL?: string;
  GHOST_SERVICE_URL?: string;

  CLOUD_BACKEND_LOCATION?: string;

  RAG_DRIVE_FOLDERS?: string;

  YOUTUBE_TRANSCRIPT_API_TOKEN?: string; // Secret

  NEXT_PUBLIC_OIDC_PROVIDER: string;
  NEXT_PUBLIC_SLACK_CLIENT_ID: string;
  NEXT_PUBLIC_SLACK_TEAM_ID: string;
  NEXT_PUBLIC_USE_HTTPS?: string;
  NEXT_PUBLIC_DEBUG_AUTH?: string;
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST?: string;
  NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST?: string;

  /** Server Secrets **/
  DOTENV_SECRETS?: string;
  SERVICE_ACCOUNT_SECRET_KEY?: string;
  SERVICE_ACCOUNT_IMPERSONATION_SUBJECT?: string;

  SERVICE_ACCOUNT_KEY_JSON_FIREBASE_COMPUTE?: string;
  SERVICE_ACCOUNT_KEY_JSON_SPRINKLESBOT?: string;

  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_USER_TOKEN?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_STATE_SECRET?: string;
  SLACK_TEAM_ID?: string;

  MAIL_SERVER?: string; // Secret
  MAIL_PORT?: string; // Secret
  MAIL_USER?: string; // Secret
  MAIL_PASSWORD?: string; // Secret
  MAIL_FROM?: string; // Address magic-link emails are sent from

  STRAVA_CLIENT_ID?: string; // Secret
  STRAVA_CLIENT_SECRET?: string; // Secret
  STRAVA_VERIFY_TOKEN?: string; // Secret
  STRAVA_REDIRECT_URI?: string; // Secret

  AUTH_SECRET?: string; // Secret
  AUTH_URL?: string;

  STRIPE_SECRET_KEY?: string; // Secret
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?: string;

  ATTENDANCE_ENABLED?: string;

  E2E_TESTING_USER?: string;
  E2E_TESTING?: string;
  E2E_PORT?: string;
  SLACK_TEST_CHANNEL?: string;

  PROFILER_LOG_LEVEL?: string;
  HOST?: string;
  PORT?: string;

  STRAVA_CLUB_ID?: string;
  STRAVA_IGNORE_ATHLETE_IDS?: string;
  ALLOWED_STRAVA_ATHLETE_IDS?: string;
  ALLOWED_EMAILS?: string; // Sign-in allowlist for email-bearing providers

  FIRESTORE_BATCH_SIZE?: string;
  FIRESTORE_WRITE_BATCH_SIZE?: string;
  PAGE_SIZE?: string;
  CONCURRENCY_LIMIT?: string;

  ENABLE_INVOICING?: string;
  AUTH_ENFORCED?: string;
  FORCE_STRUCTURED_LOGGING?: string;

  SLACK_APP_CONFIGURATION_REFRESH_TOKEN?: string; // Secret

  /** Local Development only. */

  /** Dev only */
  DEBUG?: string;
  /** Dev only */
  LOCAL?: string;
  /** Dev only */
  SLACK_APP_TOKEN?: string;
  /** Dev only */
  FUNCTIONS_EMULATOR?: string;
  /** Dev only */
  FIREBASE_AUTH_EMULATOR_HOST?: string;
  /** Dev only */
  FIRESTORE_EMULATOR_HOST?: string;
  /** Dev only */
  AUTH_EMULATOR_HOST?: string;
  /** Dev only */
  IMPERSONATE?: string;
  /** Dev only */
  IMPERSONATE_AUTOMATIC_LOGIN?: string;

  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  STRIPE_WEBHOOK_SECRET?: string; // Secret
  PRIMES_BACKEND_SERVICE_URL?: string;
  SERVICE_ACCOUNT_CLIENT_EMAIL?: string;
  SERVICE_ACCOUNT_PRIVATE_KEY?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
  AUTH_COOKIE_SIGNATURE_KEY_CURRENT?: string;
  AUTH_COOKIE_SIGNATURE_KEY_PREVIOUS?: string;
  DEBUG_DATASTORE?: string;
  NEXT_PUBLIC_URL_PREFIX?: string;
  NEXT_PUBLIC_STRIPE_ENABLED?: string;
  NEXT_PUBLIC_DEBUG_LINKS?: string;
}
