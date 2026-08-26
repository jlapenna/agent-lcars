import {
  defaultClaudeProjectsDir,
  defaultCodexSessionsDir,
  defaultSessionStateDir,
  loadSharedConfig,
  SharedWatcherConfig,
} from './config';

export interface RunnerConfig extends Pick<
  SharedWatcherConfig,
  | 'host'
  | 'heartbeatIntervalMs'
  | 'stalenessWindowMs'
  | 'firestoreProjectId'
  | 'firestoreWriterKeyJson'
  | 'firestoreEmulatorHost'
  | 'transcriptsBucket'
> {
  /** Root to discover transcripts under. Defaults to
   * `defaultClaudeProjectsDir()` (`~/.claude/projects`, optionally
   * overridden by `AGENT_TELEMETRY_CLAUDE_PROJECTS_DIR`) - deliberately NOT
   * `loadConfig().watchRoots[0].path`, since `AGENT_TELEMETRY_WATCH_ROOTS`
   * (the host watcher's multi-root override) has no bearing on runner mode;
   * claude.yml's "Start telemetry sidecar" step also passes
   * `--projects-dir "$HOME/.claude/projects"` explicitly and defensively.
   * Runner mode has no allowlist concept (see `@agent-lcars/telemetry`'s
   * `runnerWatchRoots` doc comment), so this is the only discovery knob
   * that matters here. */
  claudeProjectsDir: string;
  /** Root to discover Codex transcripts under, defaulting to
   * `defaultCodexSessionsDir()` (`~/.codex/sessions`, optionally overridden
   * by `AGENT_TELEMETRY_CODEX_SESSIONS_DIR`). Watched alongside
   * `claudeProjectsDir` rather than instead of it — see `runner.ts`'s
   * `startSidecar`, which declares both roots unconditionally. */
  codexSessionsDir: string;
  /** GitHub Actions run id — tags every doc this run ships as `runId`. */
  runId?: string;
  /** Orchestrator run ID (`broker_intent_id`) — tags every doc this run
   * ships as `intentId`, the join key a work item needs to find its
   * sessions. Distinct from `runId`, the GitHub Actions run id. */
  intentId?: string;
  /** Anchor issue/PR number — tags every doc this run ships as
   * `issueNumber`. */
  issueNumber?: number;
  /** Watched repo — `--repo owner/name`, falling back to
   * `GITHUB_REPOSITORY` (see `loadRunnerConfig`) when unset. Tags every doc
   * this run ships as `repo`. */
  repo?: { owner: string; name: string };
  /** Session-title/status overlay root (issue #1289), threaded into
   * `WatcherDaemonOptions.sessionStateDir` by `runner.ts`'s `startSidecar`
   * and read directly by `finalize.ts`. Always `defaultSessionStateDir()`
   * (`~/.local/state/agent-lcars` — `$HOME` is `/home/runner` in the
   * runner image) — the same default the host watcher falls back to (see
   * `config.ts`'s `loadConfig`), so a dispatched agent's `lcars session
   * title`/`lcars session status` writes land exactly where this reads
   * from with zero configuration. Unlike the host, runner mode has no env
   * var to opt out: the whole point of #1289 was turning this on, and an
   * ephemeral single-purpose container has no operator who'd ever want to
   * flip it back off. A container with nothing written there yet (the CLI
   * never ran, or ran before this issue existed) is not a config error —
   * `readSessionTitleOverlay`/`readSessionStatusOverlay` already treat a
   * missing directory as `available: false` and fail soft (see
   * `session-title-annotation-source.ts`), the same as an ordinary
   * workstation host that has never run `lcars session title` either. */
  sessionStateDir: string;
}

interface RunnerFlags {
  runId?: string;
  intentId?: string;
  issueNumber?: string;
  projectsDir?: string;
  codexSessionsDir?: string;
  repo?: string;
}

/**
 * Minimal `--flag value` parser for the sidecar CLI's own 6 flags
 * (`--run-id`, `--intent-id`, `--issue-number`, `--projects-dir`,
 * `--codex-sessions-dir`, `--repo` — see claude.yml's/codex.yml's "Start
 * telemetry sidecar" step). Deliberately hand-rolled
 * rather than a dependency like yargs: pulling in a full CLI-parsing
 * library would bloat the single-file bundle (`bundle` target in
 * project.json) for a command with a handful of flags. Unknown flags are
 * ignored, not rejected — fail-soft applies to argument parsing too,
 * matching this app's `runner` mode requirement that a config problem
 * never crashes the process (see main.ts's outer try/catch).
 */
function parseRunnerFlags(argv: string[]): RunnerFlags {
  const flags: RunnerFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (next === undefined) {
      continue;
    }
    if (arg === '--run-id') {
      flags.runId = next;
      i++;
    } else if (arg === '--intent-id') {
      flags.intentId = next;
      i++;
    } else if (arg === '--issue-number') {
      flags.issueNumber = next;
      i++;
    } else if (arg === '--projects-dir') {
      flags.projectsDir = next;
      i++;
    } else if (arg === '--codex-sessions-dir') {
      flags.codexSessionsDir = next;
      i++;
    } else if (arg === '--repo') {
      flags.repo = next;
      i++;
    }
  }
  return flags;
}

/**
 * Parses an `owner/name`-shaped value (a `--repo` flag or the
 * `GITHUB_REPOSITORY` env var), requiring exactly one `/` with both halves
 * non-empty. Malformed input is ignored (`undefined`) rather than thrown,
 * consistent with this file's fail-soft parsing of `--issue-number` above.
 */
function parseOwnerRepo(
  value: string | undefined,
): { owner: string; name: string } | undefined {
  if (!value) {
    return undefined;
  }
  const parts = value.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return undefined;
  }
  return { owner: parts[0], name: parts[1] };
}

/**
 * Parses the runner-mode sidecar's configuration: its own CLI flags
 * (`argv`, everything after `runner sidecar` on the command line) for
 * `runId`/`issueNumber`/`claudeProjectsDir`, layered on top of
 * `loadSharedConfig()`'s environment-driven knobs (heartbeat interval,
 * Firestore target, etc.) — the same non-privacy env vars a host watcher
 * reads, so local-testing overrides (e.g.
 * `FIRESTORE_EMULATOR_HOST`) work identically in runner mode without
 * requiring a host checkout allowlist inside a single-purpose CI container.
 */
export function loadRunnerConfig(argv: string[]): RunnerConfig {
  // Runner mode has no privacy allowlist: its container is single-purpose.
  // Load only shared settings so host-mode checkout roots are not required.
  const base = loadSharedConfig();
  const flags = parseRunnerFlags(argv);
  const issueNumber =
    flags.issueNumber !== undefined ? Number(flags.issueNumber) : undefined;
  // GITHUB_REPOSITORY (`owner/repo`) is injected by GitHub Actions into
  // every job/step automatically, so this fallback needs no workflow YAML
  // changes to start populating `repo` for issue-agent sessions.
  const repo =
    parseOwnerRepo(flags.repo) ??
    parseOwnerRepo(process.env['GITHUB_REPOSITORY']);

  return {
    claudeProjectsDir: flags.projectsDir ?? defaultClaudeProjectsDir(),
    codexSessionsDir: flags.codexSessionsDir ?? defaultCodexSessionsDir(),
    sessionStateDir: defaultSessionStateDir(),
    host: base.host,
    heartbeatIntervalMs: base.heartbeatIntervalMs,
    stalenessWindowMs: base.stalenessWindowMs,
    firestoreProjectId: base.firestoreProjectId,
    firestoreWriterKeyJson: base.firestoreWriterKeyJson,
    firestoreEmulatorHost: base.firestoreEmulatorHost,
    ...(base.transcriptsBucket && {
      transcriptsBucket: base.transcriptsBucket,
    }),
    ...(flags.runId !== undefined && { runId: flags.runId }),
    ...(flags.intentId !== undefined && { intentId: flags.intentId }),
    ...(issueNumber !== undefined &&
      !Number.isNaN(issueNumber) && { issueNumber }),
    ...(repo && { repo }),
  };
}
