import { logger } from '@agent-lcars/logging';
import { isSafeIdentifier } from '@agent-lcars/telemetry';

import { defaultClaudeProjectsDir } from './lib/config';
import { createStoreFromConfig } from './lib/create-store';
import { finalizeSidecar } from './lib/finalize';
import { resumeTranscript } from './lib/resume-transcript';
import { loadRunnerConfig } from './lib/runner-config';

/**
 * `node sidecar.cjs runner finalize --run-id <id> --issue-number <n>
 * --projects-dir <dir>` — QueueExecutor's final telemetry pass (issue #24),
 * run once the provider has exited. Does a single reduce/upload/upsert pass
 * — see `finalize.ts` for why liveness is hardcoded to `'ended'` here
 * rather than recomputed. Fail-soft is a hard requirement: a telemetry bug
 * must never fail the agent job it's instrumenting, so this always exits 0.
 */
function runRunnerFinalize(argv: string[]): void {
  try {
    const config = loadRunnerConfig(argv);
    const store = createStoreFromConfig(config);
    finalizeSidecar({ config, store })
      .catch((error) => {
        logger.error(
          'agent-lcars-telemetry-watcher: runner finalize failed (ignored; telemetry must never fail the agent job)',
          error,
        );
      })
      .finally(() => {
        process.exit(0);
      });
  } catch (error) {
    logger.error(
      'agent-lcars-telemetry-watcher: runner finalize crashed on startup; exiting 0 anyway (telemetry must never fail the agent job)',
      error,
    );
    process.exit(0);
  }
}

interface RunnerResumeFlags {
  agent?: string;
  sessionId?: string;
  transcriptUri?: string;
  cwd?: string;
  projectsDir?: string;
  projectId?: string;
  codexHome?: string;
}

/**
 * Minimal `--flag value` parser for `runner resume`'s 5 flags, matching
 * `runner-config.ts`'s `parseRunnerFlags` in spirit (hand-rolled rather than
 * a dependency, for the same single-file-bundle reason) — unknown flags are
 * ignored, not rejected.
 */
function parseRunnerResumeFlags(argv: string[]): RunnerResumeFlags {
  const flags: RunnerResumeFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (next === undefined) continue;
    if (arg === '--agent') {
      flags.agent = next;
      i++;
    } else if (arg === '--session-id') {
      flags.sessionId = next;
      i++;
    } else if (arg === '--transcript-uri') {
      flags.transcriptUri = next;
      i++;
    } else if (arg === '--cwd') {
      flags.cwd = next;
      i++;
    } else if (arg === '--projects-dir') {
      flags.projectsDir = next;
      i++;
    } else if (arg === '--project-id') {
      flags.projectId = next;
      i++;
    } else if (arg === '--codex-home') {
      flags.codexHome = next;
      i++;
    }
  }
  return flags;
}

/**
 * `node sidecar.cjs runner resume --session-id <id> --transcript-uri
 * <gcsUri> --cwd <dir> [--projects-dir <dir>] [--project-id <id>]` --
 * downloads a prior session's transcript into Claude Code's local
 * session store, so the direct runner's subsequent `claude --resume
 * <sessionId>` finds it. Prints the written path on success;
 * prints nothing (never throws, never exits nonzero) when a required
 * flag is missing, `--session-id` is not a safe identifier, or the
 * download fails -- fail-soft, matching `runner finalize`: a broken resume must degrade to a fresh run, never fail the
 * dispatch. `--session-id` is validated with the same `isSafeIdentifier`
 * guard `resumeTranscript` itself applies (defense in depth at the CLI
 * boundary, since `sessionId` arrives from untrusted document content) --
 * rejected here before `resumeTranscript` even runs. `--project-id` falls
 * back to `AGENT_TELEMETRY_PROJECT_ID` -- the same env var
 * `runner-config.ts`'s `loadRunnerConfig` already reads into
 * `RunnerConfig.firestoreProjectId` (`finalize.ts` passes that value as
 * `uploadTranscript`'s own `projectId`), so a caller that already exports
 * it for `runner finalize` needs no extra flag here.
 * `--agent <claude-code|codex|opencode>` defaults to `claude-code` so every
 * existing production call site (none of which pass it) is unaffected;
 * any other value is rejected the same fail-soft way as a missing
 * required flag. `--codex-home` is required only when `--agent codex` is
 * given -- `resumeTranscript`'s own `destinationFor` rejects a codex
 * resume with no codex home. `--agent opencode` needs neither
 * `--projects-dir` nor `--codex-home`: `resumeTranscript` imports the
 * downloaded export through the trusted OpenCode binary instead of
 * writing a file to either directory.
 * Exported for testing so a spec can exercise the real logic without
 * spawning `node` and without a real GCS call.
 */
export async function _runRunnerResumeForTesting(
  argv: string[],
  deps: {
    resumeTranscript?: typeof resumeTranscript;
    download?: Parameters<typeof resumeTranscript>[0]['download'];
  } = {},
): Promise<string | undefined> {
  const flags = parseRunnerResumeFlags(argv);
  const agent = flags.agent ?? 'claude-code';
  if (
    !flags.sessionId ||
    !flags.transcriptUri ||
    !flags.cwd ||
    !isSafeIdentifier(flags.sessionId) ||
    (agent !== 'claude-code' && agent !== 'codex' && agent !== 'opencode')
  ) {
    return undefined;
  }
  const projectId =
    flags.projectId ?? process.env['AGENT_TELEMETRY_PROJECT_ID'];
  const resume = deps.resumeTranscript ?? resumeTranscript;
  return resume({
    agent,
    sessionId: flags.sessionId,
    transcriptGcsUri: flags.transcriptUri,
    cwd: flags.cwd,
    claudeProjectsDir: flags.projectsDir ?? defaultClaudeProjectsDir(),
    ...(flags.codexHome && { codexHome: flags.codexHome }),
    ...(projectId && { projectId }),
    ...(deps.download && { download: deps.download }),
  });
}

function runRunnerResume(argv: string[]): void {
  _runRunnerResumeForTesting(argv)
    .then((written) => {
      if (written) process.stdout.write(written);
    })
    .catch((error) => {
      logger.error(
        'agent-lcars-telemetry-watcher: runner resume crashed; exiting 0 anyway (telemetry must never fail the agent job)',
        error,
      );
    })
    .finally(() => process.exit(0));
}

function main(): void {
  const [, , mode, subcommand, ...rest] = process.argv;

  if (mode === 'runner' && subcommand === 'sidecar') {
    // Retired: provider hooks (`lcars hook`) report live telemetry
    // (docs/hooks-telemetry-design.md, phase 3). Exit 0 rather than the
    // usage error below, so a stale caller can never fail a job.
    logger.warn(
      'agent-lcars-telemetry-watcher: runner sidecar is retired; provider hooks report live telemetry. Exiting.',
    );
    return;
  }

  if (mode === 'runner' && subcommand === 'finalize') {
    // Last-resort net for anything async that escapes runRunnerFinalize's
    // own try/catch, so an unhandled rejection can never propagate to a
    // nonzero exit and fail the agent job.
    process.on('uncaughtException', (error) => {
      logger.error(
        'agent-lcars-telemetry-watcher: uncaught exception in runner finalize (ignored)',
        error,
      );
    });
    process.on('unhandledRejection', (reason) => {
      logger.error(
        'agent-lcars-telemetry-watcher: unhandled rejection in runner finalize (ignored)',
        reason,
      );
    });
    runRunnerFinalize(rest);
    return;
  }

  if (mode === 'runner' && subcommand === 'resume') {
    // Same defense-in-depth net as finalize above, for the same reason.
    process.on('uncaughtException', (error) => {
      logger.error(
        'agent-lcars-telemetry-watcher: uncaught exception in runner resume (ignored)',
        error,
      );
    });
    process.on('unhandledRejection', (reason) => {
      logger.error(
        'agent-lcars-telemetry-watcher: unhandled rejection in runner resume (ignored)',
        reason,
      );
    });
    runRunnerResume(rest);
    return;
  }

  // The per-host watcher daemon that used to run here with no subcommand is
  // deleted (docs/hooks-telemetry-design.md, phase 3 follow-up): provider
  // hooks report live telemetry, so a bare invocation is a usage error.
  process.stderr.write('usage: sidecar.cjs runner <finalize|resume> [flags]\n');
  process.exitCode = 2;
}

// Only run when this file is loaded as the actual process entrypoint (`node
// sidecar.cjs ...`, direct or bundled) -- never as a side effect of a spec
// importing `_runRunnerResumeForTesting` (sub-project 6, `main.spec.ts`).
// Without this guard, importing this module under `vitest` would run
// `main()` against the test runner's own `process.argv`.
// An `import.meta.url`-vs-`process.argv[1]` entrypoint check was tried
// first and rejected: this app's tsconfig.app.json pins `module:
// "commonjs"` for its emitted declarations, and `import.meta` is a syntax
// error under `nx typecheck` there even though the runtime (vite-node in
// tests, esbuild's bundled cjs output in production) tolerates it fine.
// Vitest sets `process.env.VITEST` for every worker process it spawns
// (documented Vitest behavior, confirmed empirically while building this
// guard) -- checking that instead needs no module-syntax change and stays
// correct for both the dev `node` invocation and the bundled `sidecar.cjs`
// artifact, neither of which ever runs under Vitest.
if (!process.env['VITEST']) {
  main();
}
