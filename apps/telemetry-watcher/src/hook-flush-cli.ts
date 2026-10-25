import {
  CLI_ARCHIVE_USAGE,
  defaultCliArchiveDependencies,
  executeCliArchiveCommand,
} from './lib/cli-archive-command';
import { defaultFlushDependencies, runFlush } from './lib/hook/flush-command';

// `lcars-hook-flush.cjs`: spawned by `lcars hook <runtime>` and `lcars hook
// flush`. Never fails its caller; outcomes are recorded in hook.log.
void (async () => {
  if (process.argv[2] === 'archive') {
    if (process.argv.length === 3 || process.argv[3] === '--help') {
      process.stderr.write(`${CLI_ARCHIVE_USAGE}\n`);
      return;
    }
    try {
      const result = await executeCliArchiveCommand(
        process.argv.slice(3),
        defaultCliArchiveDependencies(),
      );
      process.stderr.write(`${result.message}\n`);
      process.exitCode = result.ok ? 0 : 1;
    } catch {
      process.stderr.write(
        'CLI archive unavailable; configure the existing telemetry writer.\n',
      );
      process.exitCode = 1;
    }
    return;
  }
  try {
    await runFlush(defaultFlushDependencies());
  } catch {
    // runFlush already logs; nothing useful to add here.
  }
  process.exitCode = 0;
})();
