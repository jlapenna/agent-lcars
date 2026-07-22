import { logger } from '@repo/logging';
import chokidar from 'chokidar';

import { loadConfig } from './lib/config';
import { createStoreFromConfig } from './lib/create-store';
import { WatcherDaemon } from './lib/daemon';
import { startRideAlong } from './lib/runner';
import { loadRunnerConfig } from './lib/runner-config';

/** Long-lived per-host daemon mode (issue #2540): watches a fixed dir for
 * the lifetime of the process, real-time-nudged by chokidar plus a periodic
 * tick as the liveness source of truth. Unchanged by the runner-mode
 * addition below. */
function runHostWatcher(): void {
  const config = loadConfig();
  const store = createStoreFromConfig(config);

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

  const daemon = new WatcherDaemon({
    watchRoots: config.watchRoots,
    host: config.host,
    store,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    stalenessWindowMs: config.stalenessWindowMs,
    shareDir: config.shareDir,
    antigravitySummaryDb: config.antigravitySummaryDb,
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
    await watcher.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/**
 * `node ride-along.cjs runner ride-along --run-id <id> --issue-number <n>
 * --projects-dir <dir>` — claude.yml's mid-run telemetry ride-along (issue
 * #3107 follow-up 5, `bundle` target in project.json). Fail-soft is a hard
 * requirement here, same as the finalize shipping step this complements: a
 * telemetry bug must never fail the agent job it's instrumenting. Every
 * branch below either starts the long-lived daemon or exits 0, and the
 * outer try/catch guarantees that even a config-load crash still exits
 * clean.
 */
function runRunnerRideAlong(argv: string[]): void {
  try {
    const config = loadRunnerConfig(argv);
    const store = createStoreFromConfig(config);
    const daemon = startRideAlong({ config, store });

    const shutdown = (signal: string) => {
      logger.info(
        `agent-lcars-telemetry-watcher: runner ride-along received ${signal}, shutting down`,
      );
      daemon.stop();
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    // Intentionally does not exit — the daemon's own interval keeps the
    // process alive until claude.yml's "Ship session telemetry" step kills
    // it by PID (see that step's ride-along.pid handling) and runs its own
    // authoritative finalize upsert.
  } catch (error) {
    logger.error(
      'agent-lcars-telemetry-watcher: runner ride-along crashed on startup; exiting 0 anyway (telemetry must never fail the agent job)',
      error,
    );
    process.exit(0);
  }
}

function main(): void {
  const [, , mode, subcommand, ...rest] = process.argv;

  if (mode === 'runner' && subcommand === 'ride-along') {
    // Last-resort net for anything async that escapes runRunnerRideAlong's
    // own try/catch (e.g. inside the daemon's interval callbacks, which
    // already fail soft per-tick — this is defense in depth so an
    // unhandled rejection anywhere in runner mode can never propagate to a
    // nonzero exit and fail the agent job).
    process.on('uncaughtException', (error) => {
      logger.error(
        'agent-lcars-telemetry-watcher: uncaught exception in runner ride-along (ignored)',
        error,
      );
    });
    process.on('unhandledRejection', (reason) => {
      logger.error(
        'agent-lcars-telemetry-watcher: unhandled rejection in runner ride-along (ignored)',
        reason,
      );
    });
    runRunnerRideAlong(rest);
    return;
  }

  runHostWatcher();
}

main();
