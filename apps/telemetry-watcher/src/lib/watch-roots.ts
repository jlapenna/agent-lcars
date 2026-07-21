import { SessionAgent } from '@agent-lcars/telemetry';

/**
 * One filesystem root the watcher discovers transcripts under, plus which
 * agent's format they're in and which project dirs within the root are in
 * scope. Introduced by #3123 phase 1 to generalize the watcher beyond
 * `~/.claude/projects`/Claude Code alone — see `config.ts`'s `loadConfig`
 * for how the default (today's only) root is built, and `daemon.ts` for how
 * multiple roots are discovered/reduced independently per tick.
 */
export interface WatchRootConfig {
  /** Directory containing one subdirectory per project (Claude Code's own
   * `~/.claude/projects/<cwd-slug>/` convention) — see `discover.ts`. */
  path: string;
  /** Which {@link TranscriptAdapter} (by `agent` name, resolved via
   * `getTranscriptAdapter` from `@agent-lcars/telemetry`) reduces files
   * discovered under this root. */
  adapter: SessionAgent;
  /** `*`-wildcard glob patterns matched against this root's project-dir
   * basenames (see `allowlist.ts`). Omitted means unfiltered — every
   * project dir under `path` is in scope — which is only appropriate for a
   * root with no privacy-scoping concern of its own (e.g. runner mode's
   * single-purpose, single-checkout container; see `runner.ts`'s
   * `RUNNER_ALLOWLIST` comment). The default host-watcher root always sets
   * this explicitly. */
  projectDirAllowlist?: string[];
  /** Descend recursively below `path`. Codex stores rollouts under
   * `sessions/YYYY/MM/DD/`, unlike Claude Code's one project-dir level. */
  recursive?: boolean;
  /** Optional privacy boundary applied to the reduced summary's cwd. */
  cwdAllowlist?: string[];
}
