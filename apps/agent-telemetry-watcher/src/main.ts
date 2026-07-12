import { logger } from '@repo/logging';
import chokidar from 'chokidar';

import { loadConfig } from './lib/config';
import { createStoreFromConfig } from './lib/create-store';
import { WatcherDaemon } from './lib/daemon';

function main() {
  const config = loadConfig();
  const store = createStoreFromConfig(config);

  logger.info(
    `agent-telemetry-watcher: starting; watching ${config.claudeProjectsDir} (allowlist: ${config.allowlist.join(', ')}), heartbeat every ${config.heartbeatIntervalMs}ms`,
  );

  const daemon = new WatcherDaemon({
    claudeProjectsDir: config.claudeProjectsDir,
    allowlist: config.allowlist,
    host: config.host,
    store,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    stalenessWindowMs: config.stalenessWindowMs,
  });

  // Real-time nudge on file changes; the periodic tick (started below) is
  // the source of truth for staleness/liveness regardless of fs events.
  const watcher = chokidar.watch(`${config.claudeProjectsDir}/**/*.jsonl`, {
    ignoreInitial: true,
  });
  watcher.on('add', () => void daemon.tick());
  watcher.on('change', () => void daemon.tick());
  watcher.on('error', (error) =>
    logger.warn('agent-telemetry-watcher: chokidar watch error', error),
  );

  daemon.start();

  const shutdown = async (signal: string) => {
    logger.info(`agent-telemetry-watcher: received ${signal}, shutting down`);
    daemon.stop();
    await watcher.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main();
