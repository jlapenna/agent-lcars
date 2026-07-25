import { createVitestConfig } from '../../vitest.config.base.mts';

export default createVitestConfig({
  dirname: __dirname,
  projectName: '@agent-lcars/telemetry-watcher',
  needsFirestoreMockShim: true,
  // A few integration specs create and mutate throwaway Git repositories.
  // Git's process-wide state and a test's cwd are unsafe shared resources;
  // run files serially so a future fixture cannot ever affect a concurrent
  // test (or the invoking worktree) through an accidental global mutation.
  fileParallelism: false,
});
