import { logger } from '@agent-lcars/logging';
import { isSafeIdentifier } from '@agent-lcars/telemetry';
import chokidar from 'chokidar';

import { defaultClaudeProjectsDir, loadConfig } from './lib/config';
import { createStoreFromConfig } from './lib/create-store';
import { WatcherDaemon } from './lib/daemon';
import { finalizeSidecar } from './lib/finalize';
import { createWatcherMetricsServer, WatcherMetrics } from './lib/metrics';
import { resumeTranscript } from './lib/resume-transcript';
import { startSidecar } from './lib/runner';
import { loadRunnerConfig } from './lib/runner-config';

/** Long-lived per-host daemon mode (issue #2540): watches a fixed dir for
 * the lifetime of the process, real-time-nudged by chokidar plus a periodic
 * tick as the liveness source of truth. Unchanged by the runner-mode
 * addition below. */
function runHostWatcher(): void {
  const config = loadConfig();
  const store = createStoreFromConfig(config);
  const metrics = new WatcherMetrics();
  const metricsServer = createWatcherMetricsServer(metrics);

  const rootsDescription = config.watchRoots
    .map(
      (root) =>
        `${root.path} (${root.adapter}, allowlist: ${(root.projectDirAllowlist ?? ['*']).join(', ')})`,
    )
    .join('; ');
  logger.info(
    `agent-lcars-telemetry-watcher: starting; watching ${rootsDescription}, heartbeat every ${config.heartbeatIntervalMs}ms`,
  );

  if (config.antigravitySummaryDb) {
    logger.info(
      `agent-lcars-telemetry-watcher: also polling antigravity summary DB at ${config.antigravitySummaryDb.path} (workspace prefixes: ${config.antigravitySummaryDb.workspacePrefixes.join(', ')})`,
    );
  }

  if (config.sessionStateDir) {
    logger.info(
      `agent-lcars-telemetry-watcher: also overlaying session titles from ${config.sessionStateDir}`,
    );
  }

  const daemon = new WatcherDaemon({
    watchRoots: config.watchRoots,
    host: config.host,
    store,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    stalenessWindowMs: config.stalenessWindowMs,
    shareDir: config.shareDir,
    antigravitySummaryDb: config.antigravitySummaryDb,
    sessionStateDir: config.sessionStateDir,
    metrics,
  });

  metricsServer.listen(config.metricsPort, config.metricsHost, () => {
    logger.info(
      `agent-lcars-telemetry-watcher: metrics listening on ${config.metricsHost}:${config.metricsPort}`,
    );
  });

  // Real-time nudge on file changes; the periodic tick (started below) is
  // the source of truth for staleness/liveness regardless of fs events.
  const watcher = chokidar.watch(
    config.watchRoots.map((root) => `${root.path}/**/*.jsonl`),
    { ignoreInitial: true },
  );
  watcher.on('add', () => void daemon.tick());
  watcher.on('change', () => void daemon.tick());
  watcher.on('error', (error) =>
    logger.warn('agent-lcars-telemetry-watcher: chokidar watch error', error),
  );

  daemon.start();

  const shutdown = async (signal: string) => {
    logger.info(
      `agent-lcars-telemetry-watcher: received ${signal}, shutting down`,
    );
    daemon.stop();
    await Promise.all([
      watcher.close(),
      new Promise<void>((resolve, reject) => {
        metricsServer.close((error) => (error ? reject(error) : resolve()));
      }),
    ]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/**
 * `node sidecar.cjs runner sidecar --run-id <id> --issue-number <n>
 * --projects-dir <dir>` — the QueueExecutor's mid-run telemetry sidecar
 * (issue #3107 follow-up 5, `bundle` target in project.json). Fail-soft is a hard
 * requirement here, same as the finalize shipping step this complements: a
 * telemetry bug must never fail the agent job it's instrumenting. Every
 * branch below either starts the long-lived daemon or exits 0, and the
 * outer try/catch guarantees that even a config-load crash still exits
 * clean.
 */
function runRunnerSidecar(argv: string[]): void {
  try {
    const config = loadRunnerConfig(argv);
    const store = createStoreFromConfig(config);
    const daemon = startSidecar({ config, store });

    const shutdown = (signal: string) => {
      logger.info(
        `agent-lcars-telemetry-watcher: runner sidecar received ${signal}, shutting down`,
      );
      daemon.stop();
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    // Intentionally does not exit — the daemon's own interval keeps the
    // process alive until sidecar-lifecycle.sh's `finalize` mode stops it by
    // PID. That stop happens via
    // `finalize` mode calling the generic job-daemon.sh's `stop`, which
    // owns the PID file in its own per-name state dir (agent-lcars#1246
    // moved PID tracking out of this script's own state dir) — only after
    // that stop completes does `runner finalize` (below) run, for the
    // authoritative last write.
  } catch (error) {
    logger.error(
      'agent-lcars-telemetry-watcher: runner sidecar crashed on startup; exiting 0 anyway (telemetry must never fail the agent job)',
      error,
    );
    process.exit(0);
  }
}

/**
 * `node sidecar.cjs runner finalize --run-id <id> --issue-number <n>
 * --projects-dir <dir>` — QueueExecutor's final telemetry pass (issue #24),
 * run once the provider has exited. Reuses the
 * same bundle/entrypoint as sidecar (no second download needed), but
 * does a single reduce/upload/upsert pass instead of starting a long-lived
 * daemon — see `finalize.ts` for why liveness is hardcoded to `'ended'`
 * here rather than recomputed. Fail-soft is a hard requirement, same as
 * sidecar: this always exits 0.
 */
function runRunnerFinalize(argv: string[]): void {
  try {
    const config = loadRunnerConfig(argv);
    const store = createStoreFromConfig(config);
    finalizeSidecar({ config, store })
      .catch((error) => {
        logger.error(
          'agent-lcars-telemetry-watcher: runner finalize failed (ignored; telemetry must never fail the agent job)',
          error,
        );
      })
      .finally(() => {
        process.exit(0);
      });
  } catch (error) {
    logger.error(
      'agent-lcars-telemetry-watcher: runner finalize crashed on startup; exiting 0 anyway (telemetry must never fail the agent job)',
      error,
    );
    process.exit(0);
  }
}

interface RunnerResumeFlags {
  sessionId?: string;
  transcriptUri?: string;
  cwd?: string;
  projectsDir?: string;
  projectId?: string;
}

/**
 * Minimal `--flag value` parser for `runner resume`'s 5 flags, matching
 * `runner-config.ts`'s `parseRunnerFlags` in spirit (hand-rolled rather than
 * a dependency, for the same single-file-bundle reason) — unknown flags are
 * ignored, not rejected.
 */
function parseRunnerResumeFlags(argv: string[]): RunnerResumeFlags {
  const flags: RunnerResumeFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (next === undefined) continue;
    if (arg === '--session-id') {
      flags.sessionId = next;
      i++;
    } else if (arg === '--transcript-uri') {
      flags.transcriptUri = next;
      i++;
    } else if (arg === '--cwd') {
      flags.cwd = next;
      i++;
    } else if (arg === '--projects-dir') {
      flags.projectsDir = next;
      i++;
    } else if (arg === '--project-id') {
      flags.projectId = next;
      i++;
    }
  }
  return flags;
}

/**
 * `node sidecar.cjs runner resume --session-id <id> --transcript-uri
 * <gcsUri> --cwd <dir> [--projects-dir <dir>] [--project-id <id>]` --
 * downloads a prior session's transcript into Claude Code's local
 * session store, so the direct runner's subsequent `claude --resume
 * <sessionId>` finds it. Prints the written path on success;
 * prints nothing (never throws, never exits nonzero) when a required
 * flag is missing, `--session-id` is not a safe identifier, or the
 * download fails -- fail-soft, matching `runner sidecar`/`runner
 * finalize`: a broken resume must degrade to a fresh run, never fail the
 * dispatch. `--session-id` is validated with the same `isSafeIdentifier`
 * guard `resumeTranscript` itself applies (defense in depth at the CLI
 * boundary, since `sessionId` arrives from untrusted document content) --
 * rejected here before `resumeTranscript` even runs. `--project-id` falls
 * back to `AGENT_TELEMETRY_PROJECT_ID` -- the same env var
 * `runner-config.ts`'s `loadRunnerConfig` already reads into
 * `RunnerConfig.firestoreProjectId` (`finalize.ts` passes that value as
 * `uploadTranscript`'s own `projectId`), so a caller that already exports
 * it for `runner sidecar`/`runner finalize` needs no extra flag here.
 * Exported for testing so a spec can exercise the real logic without
 * spawning `node` and without a real GCS call.
 */
export async function _runRunnerResumeForTesting(
  argv: string[],
  deps: {
    resumeTranscript?: typeof resumeTranscript;
    download?: Parameters<typeof resumeTranscript>[0]['download'];
  } = {},
): Promise<string | undefined> {
  const flags = parseRunnerResumeFlags(argv);
  if (
    !flags.sessionId ||
    !flags.transcriptUri ||
    !flags.cwd ||
    !isSafeIdentifier(flags.sessionId)
  ) {
    return undefined;
  }
  const projectId =
    flags.projectId ?? process.env['AGENT_TELEMETRY_PROJECT_ID'];
  const resume = deps.resumeTranscript ?? resumeTranscript;
  return resume({
    sessionId: flags.sessionId,
    transcriptGcsUri: flags.transcriptUri,
    cwd: flags.cwd,
    claudeProjectsDir: flags.projectsDir ?? defaultClaudeProjectsDir(),
    ...(projectId && { projectId }),
    ...(deps.download && { download: deps.download }),
  });
}

function runRunnerResume(argv: string[]): void {
  _runRunnerResumeForTesting(argv)
    .then((written) => {
      if (written) process.stdout.write(written);
    })
    .catch((error) => {
      logger.error(
        'agent-lcars-telemetry-watcher: runner resume crashed; exiting 0 anyway (telemetry must never fail the agent job)',
        error,
      );
    })
    .finally(() => process.exit(0));
}

function main(): void {
  const [, , mode, subcommand, ...rest] = process.argv;

  if (mode === 'runner' && subcommand === 'sidecar') {
    // Last-resort net for anything async that escapes runRunnerSidecar's
    // own try/catch (e.g. inside the daemon's interval callbacks, which
    // already fail soft per-tick — this is defense in depth so an
    // unhandled rejection anywhere in runner mode can never propagate to a
    // nonzero exit and fail the agent job).
    process.on('uncaughtException', (error) => {
      logger.error(
        'agent-lcars-telemetry-watcher: uncaught exception in runner sidecar (ignored)',
        error,
      );
    });
    process.on('unhandledRejection', (reason) => {
      logger.error(
        'agent-lcars-telemetry-watcher: unhandled rejection in runner sidecar (ignored)',
        reason,
      );
    });
    runRunnerSidecar(rest);
    return;
  }

  if (mode === 'runner' && subcommand === 'finalize') {
    // Same defense-in-depth net as sidecar above, for the same reason.
    process.on('uncaughtException', (error) => {
      logger.error(
        'agent-lcars-telemetry-watcher: uncaught exception in runner finalize (ignored)',
        error,
      );
    });
    process.on('unhandledRejection', (reason) => {
      logger.error(
        'agent-lcars-telemetry-watcher: unhandled rejection in runner finalize (ignored)',
        reason,
      );
    });
    runRunnerFinalize(rest);
    return;
  }

  if (mode === 'runner' && subcommand === 'resume') {
    // Same defense-in-depth net as sidecar/finalize above, for the same
    // reason.
    process.on('uncaughtException', (error) => {
      logger.error(
        'agent-lcars-telemetry-watcher: uncaught exception in runner resume (ignored)',
        error,
      );
    });
    process.on('unhandledRejection', (reason) => {
      logger.error(
        'agent-lcars-telemetry-watcher: unhandled rejection in runner resume (ignored)',
        reason,
      );
    });
    runRunnerResume(rest);
    return;
  }

  runHostWatcher();
}

// Only run when this file is loaded as the actual process entrypoint (`node
// sidecar.cjs ...`, direct or bundled) -- never as a side effect of a spec
// importing `_runRunnerResumeForTesting` (sub-project 6, `main.spec.ts`).
// Without this guard, importing this module under `vitest` falls through to
// `runHostWatcher()` (no `runner <subcommand>` on `process.argv`), which
// starts a real chokidar watcher and metrics HTTP server -- observed
// directly while building this guard: `runHostWatcher` also throws when
// `AGENT_TELEMETRY_CHECKOUT_ROOTS` is unset, crashing the import outright.
// An `import.meta.url`-vs-`process.argv[1]` entrypoint check was tried
// first and rejected: this app's tsconfig.app.json pins `module:
// "commonjs"` for its emitted declarations, and `import.meta` is a syntax
// error under `nx typecheck` there even though the runtime (vite-node in
// tests, esbuild's bundled cjs output in production) tolerates it fine.
// Vitest sets `process.env.VITEST` for every worker process it spawns
// (documented Vitest behavior, confirmed empirically while building this
// guard) -- checking that instead needs no module-syntax change and stays
// correct for both the dev `node` invocation and the bundled `sidecar.cjs`
// artifact, neither of which ever runs under Vitest.
if (!process.env['VITEST']) {
  main();
}
