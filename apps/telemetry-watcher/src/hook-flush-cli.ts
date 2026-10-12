import { defaultFlushDependencies, runFlush } from './lib/hook/flush-command';

// `lcars-hook-flush.cjs`: spawned by `lcars hook <runtime>` and `lcars hook
// flush`. Never fails its caller; outcomes are recorded in hook.log.
void (async () => {
  try {
    await runFlush(defaultFlushDependencies());
  } catch {
    // runFlush already logs; nothing useful to add here.
  }
  process.exitCode = 0;
})();
