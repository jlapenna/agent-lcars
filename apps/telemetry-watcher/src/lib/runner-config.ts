import { defaultClaudeProjectsDir, loadConfig, WatcherConfig } from './config';

export interface RunnerConfig extends Pick<
  WatcherConfig,
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
   * claude.yml's "Start telemetry ride-along" step also passes
   * `--projects-dir "$HOME/.claude/projects"` explicitly and defensively.
   * Runner mode has no allowlist concept (see `runner.ts`'s
   * `RUNNER_ALLOWLIST`), so this is the only discovery knob that matters
   * here. */
  claudeProjectsDir: string;
  /** GitHub Actions run id — tags every doc this run ships as `runId`. */
  runId?: string;
  /** Anchor issue/PR number — tags every doc this run ships as
   * `issueNumber`. */
  issueNumber?: number;
  /** Watched repo — `--repo owner/name`, falling back to
   * `GITHUB_REPOSITORY` (see `loadRunnerConfig`) when unset. Tags every doc
   * this run ships as `repo`. */
  repo?: { owner: string; name: string };
}

interface RunnerFlags {
  runId?: string;
  issueNumber?: string;
  projectsDir?: string;
  repo?: string;
}

/**
 * Minimal `--flag value` parser for the ride-along CLI's own 4 flags
 * (`--run-id`, `--issue-number`, `--projects-dir`, `--repo` — see
 * claude.yml's "Start telemetry ride-along" step). Deliberately hand-rolled
 * rather than a dependency like yargs: pulling in a full CLI-parsing
 * library would bloat the single-file bundle (`bundle` target in
 * project.json) for a command with exactly 4 flags. Unknown flags are
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
    } else if (arg === '--issue-number') {
      flags.issueNumber = next;
      i++;
    } else if (arg === '--projects-dir') {
      flags.projectsDir = next;
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
 * Parses the runner-mode ride-along's configuration: its own CLI flags
 * (`argv`, everything after `runner ride-along` on the command line) for
 * `runId`/`issueNumber`/`claudeProjectsDir`, layered on top of
 * `loadConfig()`'s environment-driven knobs (heartbeat interval, Firestore
 * target, etc.) — the same env vars a host watcher reads, so local-testing
 * overrides (e.g. `FIRESTORE_EMULATOR_HOST`) work identically in runner
 * mode.
 */
export function loadRunnerConfig(argv: string[]): RunnerConfig {
  const base = loadConfig();
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
    ...(issueNumber !== undefined &&
      !Number.isNaN(issueNumber) && { issueNumber }),
    ...(repo && { repo }),
  };
}
