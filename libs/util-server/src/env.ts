/** Handle special cases in env dotfiles. */

import type { EnvVars } from '@members/env';
import { isDefined } from '@members/util';

import { isTrue, optional, required, splitEnvList } from './env-util';

export const isE2eTesting = () => isTrue('E2E_TESTING');
export const getEnvNodeEnv = () => optional('NODE_ENV');
/** @deprecated Use specific helpers like isDotEnvSecrets, isMockAuthEnabled, etc. */
export const isTest = () => getEnvNodeEnv() === 'test';
export const isProduction = () => getEnvNodeEnv() === 'production';
export const isMaintenanceMode = () => process.env.MAINTENANCE_MODE === 'true';

export const getSlackAdditionalChannels = () =>
  splitEnvList('SLACK_STAFF_ADDITIONAL_CHANNELS_LIST');

export const getSlackPseudobots = () => splitEnvList('SLACK_PSEUDOBOTS');

export const getSlackQbpStaffChannel = () =>
  optional('SLACK_QBP_STAFF_CHANNEL');

export const getSlackQbpAnnounceChannel = () =>
  optional('SLACK_QBP_ANNOUNCE_CHANNEL');

export const isSlackAdmin = (slackId: string) =>
  splitEnvList('SLACK_ADMINS').includes(slackId);

/**
 * Strava-athlete admin allowlist for OneCake. OneCake authenticates Strava-only,
 * and Strava carries no email, so admin cannot be derived from `ADMIN_EMAILS`.
 * This gates admin by Strava athlete ID instead (parallel to `isSlackAdmin`).
 */
export const getOnecakeAdmins = (): string[] => splitEnvList('ONECAKE_ADMINS');

// Strava athlete ids arrive as either strings or numbers depending on the source
// (Auth.js account docs store `providerAccountId` numerically). Coerce before
// comparing so a numeric id doesn't throw `athleteId.trim is not a function`.
export const isOnecakeAdmin = (athleteId: string | number): boolean =>
  getOnecakeAdmins().includes(String(athleteId).trim());

export const getAdminEmails = (): string[] => {
  const envEmails = splitEnvList('ADMIN_EMAILS');
  if (envEmails.length > 0) {
    return envEmails.map((email) => email.toLowerCase().trim());
  }
  return [
    'jlapenna@supersprinkles.racing',
    'haley@supersprinkles.racing',
    'liz@supersprinkles.racing',
  ];
};

export const isAdminEmail = (email: string): boolean => {
  return getAdminEmails().includes(email.toLowerCase().trim());
};

export const getSlackLogLevel = () => optional('SLACK_LOG_LEVEL');

export const getLogLevel = () => optional('LOG_LEVEL');

export const getSlackAppId = () => optional('SLACK_APP_ID');

export const getNodeEnv = () => optional('NODE_ENV');

export function getStravaLogLevel(): string {
  const level = optional('STRAVA_LOG_LEVEL');
  if (level && level.length > 0) {
    return level.toLowerCase();
  }
  return 'warn';
}

export function isOnGoogleCloud(): boolean {
  // https://cloud.google.com/run/docs/container-contract#env-vars
  return (
    (isDefined(optional('K_SERVICE')) ||
      isDefined(optional('K_REVISION')) ||
      isDefined(optional('CLOUD_RUN_JOB'))) &&
    !isTrue('FUNCTIONS_EMULATOR')
  );
}

export function forceStructuredLogging(): boolean {
  return isTrue('FORCE_STRUCTURED_LOGGING');
}

export function enableRequestLogging(): boolean {
  return isTrue('ENABLE_REQUEST_LOGGING');
}
export function isAuthEnabled(): boolean {
  return isTrue('AUTH_ENABLED');
}

export function isAuthEnforced(): boolean {
  return isTrue('AUTH_ENFORCED');
}

export function enableFirestoreRequestLogging(): boolean {
  return isTrue('ENABLE_FIRESTORE_REQUEST_LOGGING');
}

export const isImpersonate = () => isTrue('IMPERSONATE');
export const isImpersonateAutomaticLogin = () =>
  isTrue('IMPERSONATE_AUTOMATIC_LOGIN');
export const getE2eTestingUser = () => optional('E2E_TESTING_USER');

export const isMockAuthEnabled = () =>
  isE2eTesting() || isImpersonateAutomaticLogin() || isImpersonate();

export const shouldConnectAuthEmulator = () =>
  isTrue('FIREBASE_AUTH_EMULATOR_HOST');
export const shouldTraceSchemaErrors = () => getEnvNodeEnv() !== 'production';
export const isCI = () => isDefined(optional('CI'));

export const isLocal = () => isTrue('LOCAL');
export const enableTestingHandlers = () =>
  isLocal() || isTest() || isE2eTesting();

export const isFunctionsEmulator = () => isTrue('FUNCTIONS_EMULATOR');

export const isEmulator = () =>
  isFunctionsEmulator() ||
  getAuthEmulatorHost() ||
  getFirebaseAuthEmulatorHost() ||
  getFirestoreEmulatorHost();

export const getAuthEmulatorHost = () => optional('AUTH_EMULATOR_HOST');

export const getFirebaseAuthEmulatorHost = () =>
  optional('FIREBASE_AUTH_EMULATOR_HOST');

export const getFirestoreEmulatorHost = () =>
  optional('FIRESTORE_EMULATOR_HOST');

export const isDotEnvSecrets = () => isTrue('DOTENV_SECRETS');

export const getPort = () => {
  const val = optional('PORT');
  return val ? parseInt(val) : undefined;
};

export const getHost = () => optional('HOST') ?? '127.0.0.1';

export const getKRevision = () => optional('K_REVISION');

export const getSlackProfileFieldStrava = () =>
  required('SLACK_PROFILE_FIELD_STRAVA');
export const getSlackProfileFieldInstagram = () =>
  required('SLACK_PROFILE_FIELD_INSTAGRAM');
export const getSlackProfileFieldRoadResults = () =>
  required('SLACK_PROFILE_FIELD_ROADRESULTS');
export const getSlackProfileFieldCrossResults = () =>
  required('SLACK_PROFILE_FIELD_CROSSRESULTS');
export const getSlackProfileFieldGravelResults = () =>
  required('SLACK_PROFILE_FIELD_GRAVELRESULTS');
export const getSlackProfileFieldAthlinks = () =>
  required('SLACK_PROFILE_FIELD_ATHLINKS');
export const getSlackProfileFieldUsac = () =>
  required('SLACK_PROFILE_FIELD_USAC');
export const getSlackProfileFieldUsacRoadCat = () =>
  required('SLACK_PROFILE_FIELD_USAC_ROAD_CAT');
export const getSlackProfileFieldUsacCrossCat = () =>
  required('SLACK_PROFILE_FIELD_USAC_CROSS_CAT');

export const getInstagramWebhookVerifyToken = () =>
  optional('INSTAGRAM_WEBHOOK_VERIFY_TOKEN');

export const getStravaClubId = () => optional('STRAVA_CLUB_ID');

export const getStravaIgnoreAthleteIds = () =>
  splitEnvList('STRAVA_IGNORE_ATHLETE_IDS');

/** Strava athlete IDs allowed to sign in (Strava returns no email to gate on). */
export const getAllowedStravaAthleteIds = () =>
  splitEnvList('ALLOWED_STRAVA_ATHLETE_IDS');

/** Emails allowed to sign in via email-bearing providers (google, magic-link). */
export const getAllowedEmails = () => splitEnvList('ALLOWED_EMAILS');

// Page size and firestore batch size should be the same default value because they are often used in concert.
export const getFirestoreBatchSize = () =>
  parseInt(optional('FIRESTORE_BATCH_SIZE') ?? '50');

// Firestore allows up to 500 writes per batch. We use a safe margin.
export const getFirestoreWriteBatchSize = () =>
  parseInt(optional('FIRESTORE_WRITE_BATCH_SIZE') ?? '450');

export const getPageSize = () => parseInt(optional('PAGE_SIZE') ?? '50');

export const getConcurrencyLimit = () =>
  parseInt(optional('CONCURRENCY_LIMIT') ?? '5');

export const getProviderMinRequestDelayMs = () =>
  parseInt(optional('PROVIDER_MIN_REQUEST_DELAY_MS') ?? '1000');

export const getProviderRequestTimeoutMs = () =>
  parseInt(optional('PROVIDER_REQUEST_TIMEOUT_MS') ?? '30000');

/**
 * A single, stable, identifying User-Agent for all outbound crawl traffic.
 * Politeness, not evasion: we never rotate this to evade blocks (see #1675 §1).
 */
export const getProviderUserAgent = () =>
  optional('PROVIDER_USER_AGENT') ??
  'SuperSprinklesRacingBot/1.0 (+https://supersprinkles.racing; bot@supersprinkles.racing)';

export const getTasksServiceUrl = () => optional('TASKS_SERVICE_URL');
export const getAgentServiceUrl = () => optional('AGENT_SERVICE_URL');
export const getWebServiceUrl = () => optional('WEB_SERVICE_URL');
export const getGhostServiceUrl = () => required('GHOST_SERVICE_URL');

export const getRacesCalendarId = () => required('RACES_CALENDAR_ID');

export const getEventsSpreadsheetId = () => required('EVENTS_SPREADSHEET_ID');

export const getEventsSpreadsheetWorksheetTitle = () =>
  optional('EVENTS_SPREADSHEET_WORKSHEET_TITLE') ?? 'Events';

export const isAttendanceEnabled = () => isTrue('ATTENDANCE_ENABLED');

export const getServiceAccountImpersonationSubject = () =>
  required('SERVICE_ACCOUNT_IMPERSONATION_SUBJECT');

export const getEffortsSpreadsheetWorksheetTitle = () =>
  required('EFFORTS_SPREADSHEET_WORKSHEET_TITLE');

export const getEffortsSpreadsheetId = () => required('EFFORTS_SPREADSHEET_ID');

export const getSegmentsSpreadsheetId = () =>
  required('SEGMENTS_SPREADSHEET_ID');

export const getSegmentsSpreadsheetWorksheetTitle = () =>
  required('SEGMENTS_SPREADSHEET_WORKSHEET_TITLE');

export const getQbpResponsesSpreadsheetId = () =>
  required('QBP_RESPONSES_SPREADSHEET_ID');

export const getQbpResponsesWorksheetTitle = () =>
  required('QBP_RESPONSES_WORKSHEET_TITLE');

export const getQbpFormId = () => required('QBP_FORM_ID');

export const isInvoicingEnabled = () => isTrue('ENABLE_INVOICING');

export const getQbpFormMetadata = () =>
  required('QBP_FORM_METADATA') as 'dev' | 'prod';

export const getQbpApiBaseUrl = () => required('QBP_API_BASE_URL');

export const getProjectId = () => {
  return (
    optional('PROJECT_ID') ||
    optional('GCLOUD_PROJECT') ||
    optional('FIREBASE_PROJECT_ID') ||
    required('PROJECT_ID')
  );
};

export const getQbpEftpHost = () => optional('QBP_EFTP_HOST');
export const getQbpEftpPort = () => {
  const val = optional('QBP_EFTP_PORT');
  return val ? parseInt(val) : undefined;
};
export const getQbpEftpLogin = () => required('QBP_EFTP_LOGIN');
export const getQbpEftpPassword = () => optional('QBP_EFTP_PASSWORD');
export const getQbpEftpShipToCode = () => optional('QBP_EFTP_SHIP_TO_CODE');
export const getQbpEftpAccountNumber = () =>
  optional('QBP_EFTP_ACCOUNT_NUMBER');

export const getVertexAiLocation = () => optional('VERTEX_AI_LOCATION');

export const getGeminiApiKey = () =>
  optional('GEMINI_API_KEY') || optional('GOOGLE_API_KEY');

// Reasoner (provider-agnostic LLM disambiguation). See #1686 / #1675 §6.0.
// The primary path is the self-hosted OpenAI-compatible endpoint; on
// timeout/error it falls back to googleai (gemini-3.5-flash by default).

/** `openai-compat` (default) | `googleai`. Selects the primary provider. */
export const getLlmProvider = (): 'openai-compat' | 'googleai' => {
  const value = optional('LLM_PROVIDER');
  return value === 'googleai' ? 'googleai' : 'openai-compat';
};

/** Base URL of the OpenAI-compatible endpoint, e.g. https://llm.jlapenna.net/v1 */
export const getLlmBaseUrl = () => optional('LLM_BASE_URL');

/** API key for the OpenAI-compatible endpoint. */
export const getLlmApiKey = () => optional('LLM_API_KEY');

/** Model id served by the primary (OpenAI-compatible) endpoint. */
export const getLlmModel = () => optional('LLM_MODEL');

/** Gemini model id used when the primary path is unavailable. */
export const getLlmFallbackModel = () =>
  optional('LLM_FALLBACK_MODEL') ?? 'gemini-3.5-flash';

export const getRagDriveFolders = () => splitEnvList('RAG_DRIVE_FOLDERS');

export const getSquareupEnvironment = () =>
  optional('SQUAREUP_ENVIRONMENT') ?? 'sandbox';

export const getSquareupApplicationId = () =>
  optional('SQUAREUP_APPLICATION_ID');

export const getSquareupLocationId = () => optional('SQUAREUP_LOCATION_ID');

export const getSquareupServiceChargeId = () =>
  optional('SQUAREUP_SERVICE_CHARGE_ID');

export const getRoadResultsTeamId = () => required('ROADRESULTS_TEAM_ID');
export const getCrossResultsTeamId = () => required('CROSSRESULTS_TEAM_ID');
export const getGravelResultsTeamId = () => required('GRAVELRESULTS_TEAM_ID');

export const getExportSpreadsheetId = () => required('EXPORT_SPREADSHEET_ID');
export const getExportSpreadsheetWorksheetTitle = () =>
  required('EXPORT_SPREADSHEET_WORKSHEET_TITLE');

export const getLookupSpreadsheetId = () => required('LOOKUP_SPREADSHEET_ID');
export const getLookupSpreadsheetSlackWorksheetTitle = () =>
  required('LOOKUP_SPREADSHEET_SLACK_WORKSHEET_TITLE');
export const getLookupSpreadsheetEmailWorksheetTitle = () =>
  required('LOOKUP_SPREADSHEET_EMAIL_WORKSHEET_TITLE');

export const getYoutubeTranscriptApiToken = () =>
  required('YOUTUBE_TRANSCRIPT_API_TOKEN');

export const getProfilerLogLevel = () => {
  const val = optional('PROFILER_LOG_LEVEL');
  return val ? parseInt(val) : 0;
};

export const getMailServer = () => required('MAIL_SERVER');
export const getMailPort = () => required('MAIL_PORT');
export const getMailUser = () => required('MAIL_USER');
export const getMailPassword = () => required('MAIL_PASSWORD');

// Optional variants used by the magic-link (email) provider, which self-disables
// when SMTP is not fully configured rather than throwing at startup.
export const getOptionalMailServer = () => optional('MAIL_SERVER');
export const getOptionalMailPort = () => optional('MAIL_PORT');
export const getOptionalMailUser = () => optional('MAIL_USER');
export const getOptionalMailPassword = () => optional('MAIL_PASSWORD');
/** Defaults to MAIL_USER when MAIL_FROM is not explicitly set. */
export const getMailFrom = () => optional('MAIL_FROM') ?? optional('MAIL_USER');
export const isMailConfigured = (): boolean =>
  !!getOptionalMailServer() &&
  !!getOptionalMailPort() &&
  !!getOptionalMailUser() &&
  !!getOptionalMailPassword();

export const getQbpApiKey = () => required('QBP_API_KEY');

export const getSquareupAccessToken = () => required('SQUAREUP_ACCESS_TOKEN');

export const getStravaClientId = () => required('STRAVA_CLIENT_ID');
export const getStravaClientSecret = () => required('STRAVA_CLIENT_SECRET');
export const getStravaVerifyToken = () => required('STRAVA_VERIFY_TOKEN');
export const getStravaRedirectUri = () => required('STRAVA_REDIRECT_URI');

export const getServiceAccountSecretKey = (): keyof EnvVars =>
  // We know that we'll set an EnvVar key in the value here. its okay.
  required('SERVICE_ACCOUNT_SECRET_KEY') as keyof EnvVars;

export const getAuthSecret = () => required('AUTH_SECRET');

export const getAuthUrl = () => required('AUTH_URL');

export const getSlackTestChannel = () => optional('SLACK_TEST_CHANNEL');

export const getSlackAnnounceChannel = () => optional('SLACK_ANNOUNCE_CHANNEL');

export const getRacesSpreadsheetId = () => required('RACES_SPREADSHEET_ID');

export const getRacesSpreadsheetWorksheetTitle = () =>
  required('RACES_SPREADSHEET_WORKSHEET_TITLE');

export const getSlackDebugChannel = () => required('SLACK_DEBUG_CHANNEL');

export const getSlackLeaderboardsChannel = () =>
  required('SLACK_LEADERBOARDS_CHANNEL');

export const getSlackRacesCronChannel = () =>
  required('SLACK_RACES_CRON_CHANNEL');

export const getSlackMgmtChannel = () => required('SLACK_MGMT_CHANNEL');

export const getSlackStaffChannel = () => required('SLACK_STAFF_CHANNEL');

export const getResultsSpreadsheetId = () => required('RESULTS_SPREADSHEET_ID');

export const getResultsSpreadsheetWorksheetTitle = () =>
  required('RESULTS_SPREADSHEET_WORKSHEET_TITLE');

export const getTeamMailingList = () => required('TEAM_MAILING_LIST');

export const getFirebaseProjectId = () =>
  optional('FIREBASE_PROJECT_ID') ||
  optional('PROJECT_ID') ||
  optional('GCLOUD_PROJECT') ||
  'dummy-project-id';

// Secrets (Development)
export const getSlackBotToken = () => optional('SLACK_BOT_TOKEN');
export const getSlackUserToken = () => optional('SLACK_USER_TOKEN');
export const getSlackAppToken = () => optional('SLACK_APP_TOKEN');
export const getSlackClientId = () => optional('SLACK_CLIENT_ID');
export const getSlackClientSecret = () => optional('SLACK_CLIENT_SECRET');
export const getSlackSigningSecret = () => optional('SLACK_SIGNING_SECRET');
export const getSlackStateSecret = () => optional('SLACK_STATE_SECRET');

export const getSlackTeamId = () => optional('SLACK_TEAM_ID');

export const getCloudTasksLocation = () => optional('CLOUD_TASKS_LOCATION');

export const getStripeSecretKey = () => optional('STRIPE_SECRET_KEY');

export const getStripeWebhookSecret = () => optional('STRIPE_WEBHOOK_SECRET');

export const getGoogleClientId = () => optional('GOOGLE_CLIENT_ID');

export const getGoogleClientSecret = () => optional('GOOGLE_CLIENT_SECRET');
