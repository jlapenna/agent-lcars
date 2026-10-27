import {
  defaultHookCommandDependencies,
  executeHookCommand,
} from './lib/hook/hook-command';

// The launcher preserves `hook` in argv. Keep the same silent, fail-open
// handler without initializing unrelated operator command modules.
void (async () => {
  await executeHookCommand(
    process.argv.slice(3),
    defaultHookCommandDependencies(),
  );
  process.exitCode = 0;
})();
