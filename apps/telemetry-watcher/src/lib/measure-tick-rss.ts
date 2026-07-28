/**
 * Standalone entry point (not a Vitest test itself) run in a child `node
 * --expose-gc` process by `daemon.memory.spec.ts`, so RSS growth from a real
 * `tick()` against a large on-disk corpus can be measured in isolation,
 * without Vitest's own baseline memory usage muddying the delta. Its optional
 * materializing mode deliberately retains the whole corpus to prove the RSS
 * guard still detects the pre-streaming failure shape.
 */
import * as fs from 'fs';

import { WatcherDaemon } from './daemon';
import { discoverTranscriptFiles } from './discover';

declare const global: { gc?: () => void };

async function main() {
  const claudeProjectsDir = process.argv[2];
  const materializeCorpus = process.argv.includes('--materialize-corpus');
  const daemon = new WatcherDaemon({
    watchRoots: [
      {
        path: claudeProjectsDir,
        adapter: 'claude-code',
        projectDirAllowlist: ['*'],
      },
    ],
    host: 'oom-regression-test',
    store: { upsertSession: () => Promise.resolve() },
    heartbeatIntervalMs: 10_000,
    stalenessWindowMs: 30_000,
    discover: discoverTranscriptFiles,
  });

  global.gc?.();
  const rssBefore = process.memoryUsage().rss;
  const retainedCorpus = materializeCorpus
    ? discoverTranscriptFiles(claudeProjectsDir, ['*']).map((filePath) =>
        fs.readFileSync(filePath),
      )
    : [];
  await daemon.tick();
  global.gc?.();
  const rssAfter = process.memoryUsage().rss;
  // Read after the final GC/RSS sample so V8 must keep every control Buffer
  // alive through the measurement.
  const materializedBytes = retainedCorpus.reduce(
    (sum, content) => sum + content.byteLength,
    0,
  );

  process.stdout.write(
    JSON.stringify({
      rssDeltaMb: (rssAfter - rssBefore) / 1e6,
      materializedBytes,
    }),
  );
}

void main();
