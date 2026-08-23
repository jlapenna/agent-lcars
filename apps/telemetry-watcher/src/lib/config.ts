import { optional } from '@agent-lcars/env';
import { SESSION_AGENTS, SessionAgent } from '@agent-lcars/telemetry';
import * as os from 'os';
import * as path from 'path';

import { defaultProjectDirAllowlist } from './allowlist';
import {
  AntigravitySummaryDbConfig,
  defaultAntigravityWorkspacePrefixes,
} from './antigravity-summary-source';
import { checkoutRoots } from './default-checkout';
import { SESSION_STATE_DIRECTORY } from './session-title-paths';
import { WatchRootConfig } from './watch-roots';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_STALENESS_MULTIPLIER = 5;
export const DEFAULT_METRICS_HOST = '0.0.0.0';
export const DEFAULT_METRICS_PORT = 9464;

export interface SharedWatcherConfig {
  host: string;
  heartbeatIntervalMs: number;
  stalenessWindowMs: number;
  firestoreProjectId?: string;
  firestoreWriterKeyJson?: string;
  firestoreEmulatorHost?: string;
  /** `gs://` bucket (name only, no scheme) used by runner finalize. */
  transcriptsBucket?: string;
}

export interface WatcherConfig extends SharedWatcherConfig {
  watchRoots: WatchRootConfig[];
  shareDir: string;
  metricsHost: string;
  metricsPort: number;
  /** Optional Antigravity summary-DB poller config (#3123 phase 3) —
   * default-enabled (see `defaultAntigravitySummaryDbPath` below), so this is
   * only ever `undefined` when `AGENT_TELEMETRY_ANTIGRAVITY_SUMMARY_DB` is
   * explicitly set to the empty string (opt-out, e.g. a host with no
   * Antigravity CLI installed at all). A default-enabled path that simply
   * doesn't exist on a given host is a *runtime* fail-soft concern (see
   * `pollAntigravitySummaries`/`daemon.ts`), not a config-time one — this
   * stays set either way. */
  antigravitySummaryDb?: AntigravitySummaryDbConfig;
  /** Optional declared session-title overlay root (issue #1212) — the local
   * directory the declared-title writer publishes beneath (see
   * `session-title-paths.ts`, `session-title-annotation-source.ts`).
   * Default-enabled (see `defaultSessionStateDir` below), so this is only
   * ever `undefined` when `AGENT_TELEMETRY_SESSION_STATE_DIR` is explicitly
   * set to the empty string (opt-out). Same convention as
   * `antigravitySummaryDb` above — see that field's comment for why unset
   * and empty differ. A missing declared-title directory is a runtime
   * fail-soft concern (see `readSessionTitleOverlay`/`daemon.ts`). */
  sessionStateDir?: string;
}

/** `~/.claude/projects` (or `AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR` when set) —
 * shared by the default watch root below and by runner mode
 * (`runner-config.ts`'s `loadRunnerConfig`), which has its own
 * `--projects-dir` flag but falls back to this exact same default. Kept as
 * its own function (rather than reading `loadConfig().watchRoots[0].path`)
 * so runner mode's fallback stays correct even when
 * `AGENT_TELEMETRY_WATCH_ROOTS` is set — that env var reconfigures the host
 * watcher's roots wholesale and has no bearing on runner mode's single,
 * allowlist-free roots (see `@agent-lcars/telemetry`'s `runnerWatchRoots`
 * doc comment). */
export function defaultClaudeProjectsDir(): string {
  return (
    optional('AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR') ??
    path.join(os.homedir(), '.claude', 'projects')
  );
}

export function defaultCodexSessionsDir(): string {
  return (
    optional('AGENT_TELEMETRY_CODEX_SESSIONS_DIR') ??
    path.join(os.homedir(), '.codex', 'sessions')
  );
}

/** `~/.gemini/antigravity-cli/conversation_summaries.db` — the Antigravity
 * CLI's global summary-tier SQLite DB (see `antigravity-summary-source.ts`).
 * Exported (like `defaultClaudeProjectsDir` above) so tests/other callers
 * can reference the same default without re-deriving it. */
export function defaultAntigravitySummaryDbPath(): string {
  return path.join(
    os.homedir(),
    '.gemini',
    'antigravity-cli',
    'conversation_summaries.db',
  );
}

/** `~/.local/state/agent-lcars` — the session-title overlay root (issue
 * #1212), see `session-title-paths.ts`'s `SESSION_STATE_DIRECTORY`.
 * Exported (like `defaultAntigravitySummaryDbPath` above) so tests/other
 * callers can reference the same default without re-deriving it. */
export function defaultSessionStateDir(): string {
  return path.join(os.homedir(), SESSION_STATE_DIRECTORY);
}

function parseAllowlistCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}

/** Builds the single default watch root — today's only behavior, preserved
 * byte-for-byte: `~/.claude/projects`, the `claude-code` adapter, and the
 * existing `defaultProjectDirAllowlist()` — honoring the two legacy
 * single-root env vars (`AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR`,
 * `AGENT_TELEMETRY_PROJECT_DIR_ALLOWLIST`) as back-compat aliases that keep
 * working as long as `AGENT_TELEMETRY_WATCH_ROOTS` isn't set. */
function defaultWatchRoot(): WatchRootConfig {
  const allowlistRaw = optional('AGENT_TELEMETRY_PROJECT_DIR_ALLOWLIST');
  return {
    path: defaultClaudeProjectsDir(),
    adapter: 'claude-code',
    projectDirAllowlist: allowlistRaw
      ? parseAllowlistCsv(allowlistRaw)
      : defaultProjectDirAllowlist(),
  };
}

function defaultCodexWatchRoot(): WatchRootConfig {
  const cwdAllowlistRaw = optional('AGENT_TELEMETRY_CODEX_CWD_ALLOWLIST');
  return {
    path: defaultCodexSessionsDir(),
    adapter: 'codex',
    recursive: true,
    cwdAllowlist: cwdAllowlistRaw
      ? parseAllowlistCsv(cwdAllowlistRaw)
      : checkoutRoots().map((root) => `${root}*`),
  };
}

function isSessionAgent(value: unknown): value is SessionAgent {
  return (
    typeof value === 'string' && SESSION_AGENTS.includes(value as SessionAgent)
  );
}

/** Validates one parsed JSON element of `AGENT_TELEMETRY_WATCH_ROOTS` against
 * the {@link WatchRootConfig} shape, throwing a specific, index-labeled error
 * for the first thing wrong with it — a malformed startup config should fail
 * loudly and immediately rather than silently watching the wrong (or no)
 * directory. */
function validateWatchRoot(entry: unknown, index: number): WatchRootConfig {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`AGENT_TELEMETRY_WATCH_ROOTS[${index}] must be an object`);
  }
  const record = entry as Record<string, unknown>;

  const rootPath = record['path'];
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    throw new Error(
      `AGENT_TELEMETRY_WATCH_ROOTS[${index}].path must be a non-empty string`,
    );
  }

  const adapter = record['adapter'];
  if (!isSessionAgent(adapter)) {
    throw new Error(
      `AGENT_TELEMETRY_WATCH_ROOTS[${index}].adapter must be one of: ${SESSION_AGENTS.join(', ')}`,
    );
  }

  const allowlist = record['projectDirAllowlist'];
  if (
    allowlist !== undefined &&
    (!Array.isArray(allowlist) ||
      !allowlist.every((pattern) => typeof pattern === 'string'))
  ) {
    throw new Error(
      `AGENT_TELEMETRY_WATCH_ROOTS[${index}].projectDirAllowlist must be an array of strings when present`,
    );
  }

  const recursive = record['recursive'];
  if (recursive !== undefined && typeof recursive !== 'boolean') {
    throw new Error(
      `AGENT_TELEMETRY_WATCH_ROOTS[${index}].recursive must be a boolean when present`,
    );
  }
  const cwdAllowlist = record['cwdAllowlist'];
  if (
    cwdAllowlist !== undefined &&
    (!Array.isArray(cwdAllowlist) ||
      !cwdAllowlist.every((pattern) => typeof pattern === 'string'))
  ) {
    throw new Error(
      `AGENT_TELEMETRY_WATCH_ROOTS[${index}].cwdAllowlist must be an array of strings when present`,
    );
  }

  return {
    path: rootPath,
    adapter,
    ...(allowlist && { projectDirAllowlist: allowlist as string[] }),
    ...(recursive !== undefined && { recursive }),
    ...(cwdAllowlist && { cwdAllowlist: cwdAllowlist as string[] }),
  };
}

/**
 * Parses `AGENT_TELEMETRY_WATCH_ROOTS`: a JSON array of
 * `{ "path": string, "adapter": SessionAgent, "projectDirAllowlist"?: string[] }`
 * objects, e.g.
 * `[{"path":"/home/dev/.claude/projects","adapter":"claude-code","projectDirAllowlist":["-home-dev-*"]},{"path":"/home/dev/.codex/sessions","adapter":"codex"}]`.
 * When set, this fully replaces the default single-root config — the legacy
 * `AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR`/`AGENT_TELEMETRY_PROJECT_DIR_ALLOWLIST`
 * vars are ignored in that case (they only alias the *default* root, which
 * this supersedes). Throws with a specific reason on malformed input rather
 * than falling back silently.
 */
function parseWatchRootsJson(raw: string): WatchRootConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `AGENT_TELEMETRY_WATCH_ROOTS is not valid JSON: ${(error as Error).message}`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      'AGENT_TELEMETRY_WATCH_ROOTS must be a non-empty JSON array of {path, adapter, projectDirAllowlist?} objects',
    );
  }
  return parsed.map((entry, index) => validateWatchRoot(entry, index));
}

/** Shared host/runner settings that do not evaluate host privacy scope. */
export function loadSharedConfig(): SharedWatcherConfig {
  const heartbeatIntervalMs = Number(
    optional('AGENT_TELEMETRY_HEARTBEAT_INTERVAL_MS') ??
      DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  const stalenessWindowMs = Number(
    optional('AGENT_TELEMETRY_STALENESS_WINDOW_MS') ??
      heartbeatIntervalMs * DEFAULT_STALENESS_MULTIPLIER,
  );

  const firestoreProjectId = optional('AGENT_TELEMETRY_PROJECT_ID');
  const transcriptsBucket =
    optional('AGENT_TELEMETRY_TRANSCRIPTS_BUCKET') ??
    (firestoreProjectId
      ? `${firestoreProjectId}-session-transcripts`
      : undefined);

  return {
    host: optional('AGENT_TELEMETRY_HOST') ?? os.hostname(),
    heartbeatIntervalMs,
    stalenessWindowMs,
    firestoreProjectId,
    firestoreWriterKeyJson: optional('AGENT_TELEMETRY_WRITER_KEY_JSON'),
    firestoreEmulatorHost: optional('FIRESTORE_EMULATOR_HOST'),
    ...(transcriptsBucket && { transcriptsBucket }),
  };
}

/** Reads and validates the long-lived host daemon's configuration. */
export function loadConfig(): WatcherConfig {
  const shared = loadSharedConfig();
  const watchRootsRaw = optional('AGENT_TELEMETRY_WATCH_ROOTS');
  const watchRoots = watchRootsRaw
    ? parseWatchRootsJson(watchRootsRaw)
    : [defaultWatchRoot(), defaultCodexWatchRoot()];

  // Default-enabled: unset means "use the default path", an explicit empty
  // string means "disable entirely" (e.g. a host with no Antigravity CLI).
  const antigravityDbRaw = optional('AGENT_TELEMETRY_ANTIGRAVITY_SUMMARY_DB');
  const antigravitySummaryDb: AntigravitySummaryDbConfig | undefined =
    antigravityDbRaw === ''
      ? undefined
      : {
          path: antigravityDbRaw ?? defaultAntigravitySummaryDbPath(),
          workspacePrefixes: defaultAntigravityWorkspacePrefixes(),
        };
  // Default-enabled: unset means "use the default path", an explicit empty
  // string means "disable the whole overlay" (e.g. a host that shouldn't
  // apply declared/generated title overlays at all). Same convention as
  // AGENT_TELEMETRY_ANTIGRAVITY_SUMMARY_DB above — see that comment for why
  // unset and empty differ.
  const sessionStateDirRaw = optional('AGENT_TELEMETRY_SESSION_STATE_DIR');
  const sessionStateDir =
    sessionStateDirRaw === ''
      ? undefined
      : (sessionStateDirRaw ?? defaultSessionStateDir());

  const metricsPort = Number(
    optional('AGENT_TELEMETRY_METRICS_PORT') ?? DEFAULT_METRICS_PORT,
  );
  if (
    !Number.isInteger(metricsPort) ||
    metricsPort < 1 ||
    metricsPort > 65535
  ) {
    throw new Error(
      'AGENT_TELEMETRY_METRICS_PORT must be an integer from 1 to 65535',
    );
  }

  return {
    ...shared,
    watchRoots,
    shareDir:
      optional('AGENT_TELEMETRY_SHARE_DIR') ?? path.join(os.homedir(), 'share'),
    metricsHost:
      optional('AGENT_TELEMETRY_METRICS_HOST') ?? DEFAULT_METRICS_HOST,
    metricsPort,
    ...(antigravitySummaryDb && { antigravitySummaryDb }),
    ...(sessionStateDir && { sessionStateDir }),
  };
}
