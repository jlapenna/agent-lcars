import { createVitestConfig } from '../../vitest.config.base.mts';

export default createVitestConfig({
  dirname: import.meta.dirname,
  projectName: '@agent-lcars/telemetry-watcher',
  needsFirestoreMockShim: true,
  overrides: {
    test: {
      // This project's suites are deliberately not pure-CPU unit tests: they
      // build real SQLite fixture databases and drive the real annotation
      // writer, which mkdirs, writes, renames, and fsyncs actual files. Every
      // one of those fsyncs is nearly free on a developer SSD and costs tens
      // of milliseconds on a GitHub-hosted runner's network-backed disk, so
      // vitest's 5s default -- a figure that assumes in-memory work -- fails
      // here for reasons that have nothing to do with the code under test.
      // Observed twice: a bulk import test at 28.9s, then, on a run that
      // changed only a YAML pin, a handful of *small* fixture tests timing
      // out at 5s while the same suite had passed minutes earlier.
      //
      // Scoped to this project rather than the workspace on purpose. The
      // other projects' tests really are in-memory, and blunting their
      // timeout to cover this one's I/O would hide a genuine hang in code
      // that should never take seconds. 30s is far above anything measured
      // here (the slowest bulk test runs in well under a second locally)
      // while still being short enough to catch a deadlock rather than
      // waiting out the job. Individual bulk-filesystem tests that need even
      // more carry their own explicit trailing timeout.
      testTimeout: 30_000,
    },
  },
});
