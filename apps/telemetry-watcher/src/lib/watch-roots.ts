/**
 * Introduced by #3123 phase 1 to generalize the watcher beyond
 * `~/.claude/projects`/Claude Code alone — see `config.ts`'s `loadConfig`
 * for how the host watcher's default roots are built, and `daemon.ts` for
 * how multiple roots are discovered/reduced independently per tick.
 *
 * The type itself moved to `@agent-lcars/telemetry` (`runner-capture.ts`)
 * in #645, alongside the runner-mode watch-root *list* that used to be
 * hand-copied between `runner.ts` and `finalize.ts` — re-exported here so
 * this app's many existing `./watch-roots` imports don't all need to change
 * to reach into the shared package directly.
 */
export type { WatchRootConfig } from '@agent-lcars/telemetry';
