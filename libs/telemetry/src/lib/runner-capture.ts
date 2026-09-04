import { SessionAgent } from './types';

/**
 * One filesystem root a telemetry watcher pass discovers transcripts under,
 * plus which agent's format they're in and which project dirs within the
 * root are in scope. Canonical home for this shape (#645) — it used to be
 * declared independently in `apps/telemetry-watcher/src/lib/watch-roots.ts`,
 * which now just re-exports this type so that app's existing `./watch-roots`
 * imports (`config.ts`, `discover.ts`, `daemon.ts`, `runner.ts`,
 * `finalize.ts`) don't all need to change. See {@link runnerWatchRoots}
 * below for the one runner-mode watch-root *list*, moved for the same
 * reason.
 */
export interface WatchRootConfig {
  /** Directory containing one subdirectory per project (Claude Code's own
   * `~/.claude/projects/<cwd-slug>/` convention), or, when {@link recursive}
   * is set, a root walked in full (Codex's `~/.codex/sessions/<yyyy>/<mm>/
   * <dd>/` convention). */
  path: string;
  /** Which registered transcript adapter (by `agent` name, resolved via
   * `getTranscriptAdapter` — see `transcript-adapter.ts`) reduces files
   * discovered under this root. */
  adapter: SessionAgent;
  /** `*`-wildcard glob patterns matched against this root's project-dir
   * basenames. Omitted means unfiltered — every project dir under `path` is
   * in scope — which is only appropriate for a root with no privacy-scoping
   * concern of its own (e.g. a runner container's single-purpose, single
   * checkout — see {@link runnerWatchRoots}'s doc comment). The host
   * watcher's default root always sets this explicitly. */
  projectDirAllowlist?: string[];
  /** Descend recursively below `path`. Codex stores rollouts under
   * `sessions/YYYY/MM/DD/`, unlike Claude Code's one project-dir level. */
  recursive?: boolean;
  /** Optional privacy boundary applied to the reduced summary's cwd. */
  cwdAllowlist?: string[];
}

/**
 * Agents a runner-mode telemetry pass (`runnerWatchRoots`, below) actually
 * has a capture root and registered `TranscriptAdapter` for. OpenCode's root
 * is populated by the watcher's bounded `opencode export` materializer; the
 * CLI's supported export contract keeps this package independent from the
 * SQLite schema behind OpenCode's global session store.
 */
export const RUNNER_CAPTURE_AGENTS: readonly SessionAgent[] = [
  'claude-code',
  'codex',
  'opencode',
];

/**
 * The single definition of the watch-root list a runner-mode telemetry pass
 * discovers transcripts under — every agent this repo has a working
 * transcript adapter for (see {@link RUNNER_CAPTURE_AGENTS}), unconditionally.
 * A dispatch workflow only ever runs one of them, and the other roots simply
 * discovers nothing; that's cheaper and far less error-prone than having
 * each workflow declare which agent it is.
 *
 * `startSidecar` (`apps/telemetry-watcher/src/lib/runner.ts`) and
 * `finalizeSidecar` (`finalize.ts`) both call this instead of each hand-
 * copying the array, as they did before #645 — finalize.ts's copy carried a
 * comment admitting it "must mirror startSidecar's roots exactly," which is
 * precisely the kind of duplicated contract this issue's telemetry-capture
 * work exists to retire. Extending runner-mode capture to a new agent means
 * adding one entry here (plus a `TranscriptAdapter`, see
 * `transcript-adapter.ts`), not editing two call sites in lockstep.
 *
 * A runner container has no privacy-scoping concept the way the host
 * watcher does (see `allowlist.ts`'s `defaultProjectDirAllowlist` comment):
 * it is single-purpose and destroyed after one job, so the `*` wildcard
 * allowlists below are a no-op here, not a scoping gap.
 */
export function runnerWatchRoots(config: {
  claudeProjectsDir: string;
  codexSessionsDir: string;
  opencodeExportsDir: string;
}): WatchRootConfig[] {
  return [
    {
      path: config.claudeProjectsDir,
      adapter: 'claude-code',
      projectDirAllowlist: ['*'],
    },
    {
      path: config.codexSessionsDir,
      adapter: 'codex',
      // Codex writes `~/.codex/sessions/<yyyy>/<mm>/<dd>/<uuid>.jsonl`, so
      // unlike Claude's flat project dirs this root must be walked.
      recursive: true,
      cwdAllowlist: ['*'],
    },
    {
      path: config.opencodeExportsDir,
      adapter: 'opencode',
      projectDirAllowlist: ['sessions'],
    },
  ];
}

/**
 * Builds the GCS object path a finalized transcript archives to:
 * `runs/<runId>/<adapter>/<sessionId>.jsonl` — a function of the adapter
 * that actually captured the session, never a hardcoded literal. Before
 * #645, `finalize.ts` hardcoded the `claude-code/` path segment
 * unconditionally, so every Codex run's transcript archived under the wrong
 * per-agent prefix despite `discoverAcrossRoots` already knowing (via each
 * discovered file's `root.adapter`) which agent actually produced it.
 */
export function transcriptObjectPath(options: {
  runId: string | undefined;
  adapter: SessionAgent;
  sessionId: string;
}): string {
  return `runs/${options.runId ?? 'unknown'}/${options.adapter}/${options.sessionId}.jsonl`;
}

/** The resumable sibling of {@link transcriptObjectPath}. A distinct
 *  extension, so the `*.jsonl` transcript discovery never picks it up as a
 *  session of its own. */
export function resumeObjectPath(options: {
  runId: string | undefined;
  adapter: SessionAgent;
  sessionId: string;
}): string {
  return `runs/${options.runId ?? 'unknown'}/${options.adapter}/${options.sessionId}.export.json`;
}

/**
 * Claude Code's own project-directory encoding for an absolute checkout
 * path: every character other than `[A-Za-z0-9]` becomes `-`, one-for-one
 * (a run of two non-alphanumeric characters — e.g. `/.` — becomes two
 * dashes, not one; nothing is collapsed). Verified empirically, not
 * assumed: `CLAUDE_CONFIG_DIR=<tmp> claude -p ... --dangerously-skip-
 * permissions` run from a scratch cwd containing `.`, `_`, and `+`
 * (`repo.name_x+y`) produced `<tmp>/projects/` entries with those
 * characters, and only those, turned into `-` (`repo-name-x-y`); cross-
 * checked against this machine's real `~/.claude/projects/` entries for a
 * `.`-containing cwd (`/home/jlapenna/.openclaw` → `
 * -home-jlapenna--openclaw` — the double dash is `/` then `.`, each its own
 * dash, proving no collapsing) and for the Claude binary's own bundled
 * `k(t)` cache-directory-naming helper (`apps/telemetry-watcher` runner
 * image ships Claude Code; `t.replace(/[^a-zA-Z0-9]/g,"-")`, found via
 * `strings` on the installed CLI binary), which uses the identical rule
 * for a sibling cwd-derived directory name. (`-` itself is `[^a-zA-Z0-9]`
 * too, so replacing it with `-` is a no-op either way `-` is or isn't in
 * the allowed set.)
 *
 * Deliberately DIFFERENT from and NOT a drop-in replacement for
 * `apps/telemetry-watcher/src/lib/default-checkout.ts`'s
 * `checkoutSlugGlobs` (`root.replace(/\//g, '-')` plus a trailing `*`
 * wildcard): that function builds a discovery GLOB for the host watcher's
 * privacy allowlist, where slash-only substitution plus a wildcard tail
 * already matches every real project dir prefixed by the checkout root
 * regardless of what Claude Code does to characters after the root's own
 * path — correctness there never depended on getting the encoding
 * byte-exact. This function instead has to name the exact directory a
 * `claude --resume` will look in, so it has to reproduce Claude Code's
 * real encoding, not the glob's looser one. `checkoutSlugGlobs` is
 * unchanged and stays on its own, narrower rule.
 *
 * Inverted by `resume-transcript.ts` (sub-project 6): given a checkout
 * directory, this names the subdirectory under `~/.claude/projects/` a
 * resumed session's transcript must be written to before Claude Code can
 * `--resume` it.
 */
export function claudeProjectSlugFor(absoluteCwd: string): string {
  return absoluteCwd.replace(/[^a-zA-Z0-9]/g, '-');
}
