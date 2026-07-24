import { SESSION_AGENTS, SessionAgent } from '@agent-lcars/telemetry';
import { optional } from '@repo/env';
import * as os from 'os';
import * as path from 'path';

import { DEFAULT_PROJECT_DIR_ALLOWLIST } from './allowlist';
import {
  AntigravitySummaryDbConfig,
  DEFAULT_ANTIGRAVITY_WORKSPACE_PREFIXES,
} from './antigravity-summary-source';
import { WatchRootConfig } from './watch-roots';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_STALENESS_MULTIPLIER = 5;

export interface WatcherConfig {
  watchRoots: WatchRootConfig[];
  host: string;
  heartbeatIntervalMs: number;
  stalenessWindowMs: number;
  shareDir: string;
  firestoreProjectId?: string;
  firestoreWriterKeyJson?: string;
  firestoreEmulatorHost?: string;
  /** `gs://` bucket (name only, no scheme) that `runner finalize` (issue #24)
   * archives a session's raw transcript to before shipping its final `ended`
   * doc — see `finalize.ts`. Defaults to `${firestoreProjectId}-session-transcripts`,
   * matching the bucket name literal in infra/terraform/main.tf's
   * `google_storage_bucket.transcripts` (`AGENT_TELEMETRY_TRANSCRIPTS_BUCKET`
   * overrides it, e.g. for local testing against a different bucket).
   * `undefined` when `firestoreProjectId` is also unset, since there is no
   * project to derive a bucket name from. */
  transcriptsBucket?: string;
  /** Optional Antigravity summary-DB poller config (#3123 phase 3) —
   * default-enabled (see `defaultAntigravitySummaryDbPath` below), so this is
   * only ever `undefined` when `AGENT_TELEMETRY_ANTIGRAVITY_SUMMARY_DB` is
   * explicitly set to the empty string (opt-out, e.g. a host with no
   * Antigravity CLI installed at all). A default-enabled path that simply
   * doesn't exist on a given host is a *runtime* fail-soft concern (see
   * `pollAntigravitySummaries`/`daemon.ts`), not a config-time one — this
   * stays set either way. */
  antigravitySummaryDb?: AntigravitySummaryDbConfig;
}

/** `~/.claude/projects` (or `AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR` when set) —
 * shared by the default watch root below and by runner mode
 * (`runner-config.ts`'s `loadRunnerConfig`), which has its own
 * `--projects-dir` flag but falls back to this exact same default. Kept as
 * its own function (rather than reading `loadConfig().watchRoots[0].path`)
 * so runner mode's fallback stays correct even when
 * `AGENT_TELEMETRY_WATCH_ROOTS` is set — that env var reconfigures the host
 * watcher's roots wholesale and has no bearing on runner mode's single,
 * allowlist-free root (see runner.ts's `RUNNER_ALLOWLIST` comment). */
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

function parseAllowlistCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}

/** Builds the single default watch root — today's only behavior, preserved
 * byte-for-byte: `~/.claude/projects`, the `claude-code` adapter, and the
 * existing `DEFAULT_PROJECT_DIR_ALLOWLIST` — honoring the two legacy
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
      : DEFAULT_PROJECT_DIR_ALLOWLIST,
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
      : ['/home/jlapenna/p/members*'],
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

/** Reads and validates the daemon's configuration from the environment. */
export function loadConfig(): WatcherConfig {
  const heartbeatIntervalMs = Number(
    optional('AGENT_TELEMETRY_HEARTBEAT_INTERVAL_MS') ??
      DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  const stalenessWindowMs = Number(
    optional('AGENT_TELEMETRY_STALENESS_WINDOW_MS') ??
      heartbeatIntervalMs * DEFAULT_STALENESS_MULTIPLIER,
  );

  const watchRootsRaw = optional('AGENT_TELEMETRY_WATCH_ROOTS');
  const watchRoots = watchRootsRaw
    ? parseWatchRootsJson(watchRootsRaw)
    : [defaultWatchRoot(), defaultCodexWatchRoot()];

  // Default-enabled: unset means "use the default path", an explicit empty
  // string means "disable entirely" (e.g. a host with no Antigravity CLI) -
  // distinct from `AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR`'s override-only
  // semantics above since this source has no equivalent opt-in trigger.
  const antigravityDbRaw = optional('AGENT_TELEMETRY_ANTIGRAVITY_SUMMARY_DB');
  const antigravitySummaryDb: AntigravitySummaryDbConfig | undefined =
    antigravityDbRaw === ''
      ? undefined
      : {
          path: antigravityDbRaw ?? defaultAntigravitySummaryDbPath(),
          workspacePrefixes: DEFAULT_ANTIGRAVITY_WORKSPACE_PREFIXES,
        };

  const firestoreProjectId = optional('AGENT_TELEMETRY_PROJECT_ID');
  const transcriptsBucket =
    optional('AGENT_TELEMETRY_TRANSCRIPTS_BUCKET') ??
    (firestoreProjectId
      ? `${firestoreProjectId}-session-transcripts`
      : undefined);

  return {
    watchRoots,
    host: optional('AGENT_TELEMETRY_HOST') ?? os.hostname(),
    heartbeatIntervalMs,
    stalenessWindowMs,
    shareDir:
      optional('AGENT_TELEMETRY_SHARE_DIR') ?? path.join(os.homedir(), 'share'),
    firestoreProjectId,
    firestoreWriterKeyJson: optional('AGENT_TELEMETRY_WRITER_KEY_JSON'),
    firestoreEmulatorHost: optional('FIRESTORE_EMULATOR_HOST'),
    ...(transcriptsBucket && { transcriptsBucket }),
    ...(antigravitySummaryDb && { antigravitySummaryDb }),
  };
}
