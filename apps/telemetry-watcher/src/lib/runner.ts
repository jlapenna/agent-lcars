import { logger } from '@repo/logging';

import { WatcherDaemon } from './daemon';
import { RunnerConfig } from './runner-config';
import { SessionStore } from './store';

/**
 * Runner mode has no privacy-scoping concept the way the host watcher does
 * (see `allowlist.ts`'s `defaultProjectDirAllowlist` comment): a
 * claude.yml runner container is single-purpose and destroyed after one
 * job — there's exactly one checkout, one agent turn, and nothing else
 * ever lands under `$HOME/.claude/projects` on it, unlike a developer
 * workstation that can have many unrelated Claude Code projects under the
 * same root. A `*` wildcard is therefore not a scoping gap here, just a
 * no-op allowlist check.
 */
const RUNNER_ALLOWLIST = ['*'];

/**
 * The same reasoning applied to Codex's own `cwd`-keyed allowlist. The host
 * watcher scopes codex sessions to `checkoutRoot()*`
 * (the configured checkout root) because a workstation runs Codex against
 * many unrelated checkouts; a runner container has exactly one, at a path
 * (`/home/runner/_work/...`) that would never match that workstation glob.
 * Reusing the host default here would silently discard every session this
 * sidecar exists to record — so runner mode gets the same no-op wildcard as
 * Claude above.
 */
const RUNNER_CODEX_CWD_ALLOWLIST = ['*'];

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
    // Both agents' transcript roots, unconditionally. A dispatch workflow
    // only ever runs one of them, and the other root simply discovers
    // nothing — cheaper and far less error-prone than having each workflow
    // declare which agent it is. Until codex.yml existed this watched only
    // Claude, which meant a Codex run would have shipped no telemetry at
    // all: no turns, no tokens, no session row in the console.
    watchRoots: [
      {
        path: config.claudeProjectsDir,
        adapter: 'claude-code',
        projectDirAllowlist: RUNNER_ALLOWLIST,
      },
      {
        path: config.codexSessionsDir,
        adapter: 'codex',
        // Codex writes `~/.codex/sessions/<yyyy>/<mm>/<dd>/<uuid>.jsonl`,
        // so unlike Claude's flat project dirs this root must be walked.
        recursive: true,
        cwdAllowlist: RUNNER_CODEX_CWD_ALLOWLIST,
      },
    ],
    // Every transcript on a dispatch runner belongs to that job's agent
    // run, whatever the transcript itself claims — see
    // BuildSessionDocOptions.forceSource.
    forceSource: 'issue-agent',
    host: config.host,
    store,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    stalenessWindowMs: config.stalenessWindowMs,
    shareDir: undefined,
    runId: config.runId,
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
