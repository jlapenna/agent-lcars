import { logger } from '@agent-lcars/logging';
import { runnerWatchRoots } from '@agent-lcars/telemetry';

import { WatcherDaemon } from './daemon';
import { RunnerConfig } from './runner-config';
import { SessionStore } from './store';

export interface StartSidecarOptions {
  config: RunnerConfig;
  store: SessionStore;
  /** Test-only injection points, mirrored 1:1 from `WatcherDaemonOptions` —
   * production callers (main.ts) never set these, so the daemon uses real
   * `fs`/`/proc`/`git`. */
  discover?: (rootPath: string, allowlist: string[]) => string[];
  readFile?: (filePath: string) => string;
  statFile?: (filePath: string) => { mtimeMs: number; size: number };
  isProcessAliveForCwd?: (cwd: string) => boolean;
  resolveGitBranch?: (cwd: string) => Promise<string | undefined>;
  resolveGitRepo?: (
    cwd: string,
  ) => Promise<{ owner: string; name: string } | undefined>;
  now?: () => string;
  /** Test-only: skip the initial `daemon.start()` call so a test can drive
   * `daemon.tick()` explicitly instead of racing the fire-and-forget first
   * tick `start()` kicks off. Defaults to `true` (real usage always starts
   * the loop). */
  autoStart?: boolean;
}

/**
 * Starts the long-lived sidecar loop for the duration of the agent's
 * turn (issue #3107 follow-up 5): on a fixed interval
 * (`config.heartbeatIntervalMs`, ~10s by default), discovers every
 * transcript under the runner's `$HOME/.claude/projects` and
 * `$HOME/.codex/sessions`, reduces it, and upserts a session doc tagged
 * with `runId`/`issueNumber`. This is what
 * lights up the Agent LCARS's In-Flight UI (#3092) mid-run instead of
 * only after the job ends — that UI already renders gauges whenever a live
 * session doc exists, so shipping docs mid-run needs zero console changes.
 *
 * Reuses `WatcherDaemon` wholesale (its per-tick read/stat/reduce/store
 * error handling is already fail-soft — see daemon.spec.ts) rather than
 * reimplementing discovery/liveness here. Every doc is forced to
 * `source: 'issue-agent'`: Claude's reducer infers that from the
 * transcript's own `claude-code-github-action` entrypoint marker, but Codex
 * emits no equivalent, so the marker can't be the sole signal.
 *
 * Runner (`issue-agent`) sessions have no artifact story yet (see
 * `libs/telemetry/src/lib/types.ts`), so `shareDir` is intentionally
 * left unset — `buildSessionDoc` would drop artifacts for `issue-agent`
 * docs anyway, but skipping the scan avoids the pointless filesystem work.
 *
 * The final, authoritative upsert for this run comes from claude.yml's
 * "Finalize telemetry sidecar" step (after "Run Claude Code" ends, issue
 * #24) — that step kills this daemon by PID, then invokes `runner finalize`
 * (see `finalize.ts`), which marks the session `ended` and attaches
 * `transcriptGcsUri`; this function only ever produces intermediate
 * `live`/`idle` snapshots. Callers must kill the returned daemon (`stop()`)
 * before that finalize step runs so its authoritative write always lands
 * last.
 *
 * Returns the daemon so the caller can `stop()` it on shutdown.
 */
export function startSidecar(options: StartSidecarOptions): WatcherDaemon {
  const { config, store } = options;

  const daemon = new WatcherDaemon({
    // The single runner-mode watch-root contract (@agent-lcars/telemetry,
    // #645) — both captured agents' transcript roots, unconditionally. A
    // dispatch workflow only ever runs one of them, and the other root
    // simply discovers nothing — cheaper and far less error-prone than
    // having each workflow declare which agent it is. Until codex.yml
    // existed this watched only Claude, which meant a Codex run would have
    // shipped no telemetry at all: no turns, no tokens, no session row in
    // the console. `finalizeSidecar` (finalize.ts) imports this exact same
    // function rather than hand-copying the array, so the two passes can
    // never drift apart the way they used to.
    watchRoots: runnerWatchRoots({
      claudeProjectsDir: config.claudeProjectsDir,
      codexSessionsDir: config.codexSessionsDir,
    }),
    // Every transcript on a dispatch runner belongs to that job's agent
    // run, whatever the transcript itself claims — see
    // BuildSessionDocOptions.forceSource.
    forceSource: 'issue-agent',
    host: config.host,
    store,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    stalenessWindowMs: config.stalenessWindowMs,
    shareDir: undefined,
    // Issue #1289: the one line that turns the overlay on for runner mode.
    // `config.sessionStateDir` is always `defaultSessionStateDir()` (see
    // `runner-config.ts`) — WatcherDaemon.tick() already reads both title
    // channels and the status channel from this same root unconditionally
    // whenever it's set (see daemon.ts's `sessionStateDir` handling), so a
    // dispatched agent's `lcars session title`/`lcars session status`
    // writes reach the live session doc with no other change here. Before
    // #1289 this was deliberately never set (#1212) — a dispatch runner's
    // container had a `lcars` CLI that couldn't run (0 references in
    // runner-image/Dockerfile) writing to a directory this daemon never
    // read, so there was nothing to turn on yet.
    sessionStateDir: config.sessionStateDir,
    runId: config.runId,
    intentId: config.intentId,
    issueNumber: config.issueNumber,
    repo: config.repo,
    discover: options.discover,
    readFile: options.readFile,
    statFile: options.statFile,
    isProcessAliveForCwd: options.isProcessAliveForCwd,
    resolveGitBranch: options.resolveGitBranch,
    resolveGitRepo: options.resolveGitRepo,
    now: options.now,
  });

  logger.info(
    `agent-lcars-telemetry-watcher: runner sidecar starting (run ${config.runId ?? 'unknown'}, issue #${config.issueNumber ?? 'unknown'}); watching ${config.claudeProjectsDir} and ${config.codexSessionsDir} every ${config.heartbeatIntervalMs}ms`,
  );

  if (options.autoStart ?? true) {
    daemon.start();
  }
  return daemon;
}
