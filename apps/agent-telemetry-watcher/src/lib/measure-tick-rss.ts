/**
 * Standalone entry point (not a Jest test itself) run in a child `node
 * --expose-gc` process by `daemon.memory.spec.ts`, so RSS growth from a real
 * `tick()` against a large on-disk corpus can be measured in isolation,
 * without Jest's own baseline memory usage muddying the delta.
 */
import { WatcherDaemon } from './daemon';
import { discoverTranscriptFiles } from './discover';

declare const global: { gc?: () => void };

async function main() {
  const claudeProjectsDir = process.argv[2];
  const daemon = new WatcherDaemon({
    claudeProjectsDir,
    allowlist: ['*'],
    host: 'oom-regression-test',
    store: { upsertSession: () => Promise.resolve() },
    heartbeatIntervalMs: 10_000,
    stalenessWindowMs: 30_000,
    discover: discoverTranscriptFiles,
  });

  global.gc?.();
  const rssBefore = process.memoryUsage().rss;
  await daemon.tick();
  global.gc?.();
  const rssAfter = process.memoryUsage().rss;

  process.stdout.write(
    JSON.stringify({ rssDeltaMb: (rssAfter - rssBefore) / 1e6 }),
  );
}

void main();
