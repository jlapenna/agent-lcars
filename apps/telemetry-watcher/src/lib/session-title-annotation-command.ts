import {
  pollCodexNativeTitles,
  resolveCodexStateDbPath,
} from './codex-native-title-source';
import { resolveSessionId } from './session-id';
import {
  clearSessionTitleAnnotation,
  SessionTitleAnnotationWriterDependencies,
  writeSessionTitleAnnotation,
} from './session-title-annotation-writer';
import {
  DECLARED_TITLE_SUBDIRECTORY,
  GENERATED_TITLE_SUBDIRECTORY,
} from './session-title-paths';

export interface SessionTitleAnnotationCommandDependencies extends SessionTitleAnnotationWriterDependencies {
  env?: NodeJS.ProcessEnv;
}

export interface SessionTitleAnnotationCommandResult {
  readonly ok: boolean;
  /** A deliberately generic, non-secret diagnostic suitable for CLI output. */
  readonly error?: 'invalid-command' | 'invalid-session' | 'write-failed';
  /** Present on every `invalid-command` result and on an explicit
   * `--help`/`-h`/no-argv invocation, so an agent that got the grammar
   * wrong learns the whole surface without digging through docs. Never
   * includes a title, path, id, or filesystem detail -- same
   * non-disclosure rule as every other field on this result. */
  readonly usage?: string;
}

export const SESSION_TITLE_CLI_USAGE =
  'usage: session title "<text>" | session title --clear | session import-native';

function invalidCommand(): SessionTitleAnnotationCommandResult {
  return {
    ok: false,
    error: 'invalid-command',
    usage: SESSION_TITLE_CLI_USAGE,
  };
}

function isHelpRequest(argv: readonly string[]): boolean {
  return (
    argv.length === 0 ||
    argv[0] === '--help' ||
    argv[0] === '-h' ||
    argv[0] === 'help'
  );
}

function runTitleSubcommand(
  commandArgs: readonly string[],
  dependencies: SessionTitleAnnotationCommandDependencies,
): SessionTitleAnnotationCommandResult {
  const resolution = resolveSessionId(dependencies.env);
  if (!resolution.ok) {
    return { ok: false, error: 'invalid-session' };
  }
  const sessionId = resolution.sessionId;

  if (commandArgs.length === 1 && commandArgs[0] === '--clear') {
    return clearSessionTitleAnnotation(
      sessionId,
      DECLARED_TITLE_SUBDIRECTORY,
      dependencies,
    ).ok
      ? { ok: true }
      : { ok: false, error: 'write-failed' };
  }

  if (
    commandArgs.length !== 1 ||
    commandArgs[0].startsWith('--') ||
    commandArgs[0].length === 0
  ) {
    return invalidCommand();
  }

  return writeSessionTitleAnnotation(
    sessionId,
    commandArgs[0],
    DECLARED_TITLE_SUBDIRECTORY,
    dependencies,
  ).ok
    ? { ok: true }
    : { ok: false, error: 'write-failed' };
}

/**
 * Imports Codex's own thread titles into the `generated` channel. Unlike
 * `session title`, this does NOT need a current session id -- it operates
 * over the *entire* Codex thread store in one pass (see
 * `codex-native-title-source.ts`), not one session singled out by the
 * environment, so it never calls `resolveSessionId`.
 *
 * Idempotent by construction: given an unchanged Codex DB and (in a test)
 * a pinned clock, rerunning writes byte-identical envelopes -- each row
 * maps to the same candidate every time, and the writer always publishes
 * via the same atomic write-then-rename regardless of what (if anything)
 * was there before.
 *
 * Fails soft throughout, matching `pollCodexNativeTitles`'s own contract:
 * an absent/locked/schema-mismatched DB is the common case (most hosts
 * don't run Codex, or a live Codex process holds a brief lock) and is
 * reported as `{ ok: true }` with nothing imported, never as a command
 * failure. A single row that fails to write does not stop its siblings.
 */
function runImportNativeSubcommand(
  dependencies: SessionTitleAnnotationCommandDependencies,
): SessionTitleAnnotationCommandResult {
  const dbPath = resolveCodexStateDbPath({
    env: dependencies.env,
    homeDirectory: dependencies.homeDirectory,
  });
  if (dbPath) {
    const candidates = pollCodexNativeTitles(dbPath);
    for (const candidate of candidates) {
      writeSessionTitleAnnotation(
        candidate.sessionId,
        candidate.title,
        GENERATED_TITLE_SUBDIRECTORY,
        dependencies,
      );
    }
  }
  return { ok: true };
}

/**
 * Executes the `session` command's three subcommands:
 * `session title "<text>"`, `session title --clear`, and
 * `session import-native`. Directory selection is never a command input --
 * each subcommand's channel is fixed by which of the two it is.
 */
export function executeSessionTitleAnnotationCommand(
  argv: readonly string[],
  dependencies: SessionTitleAnnotationCommandDependencies = {},
): SessionTitleAnnotationCommandResult {
  if (isHelpRequest(argv)) {
    return { ok: true, usage: SESSION_TITLE_CLI_USAGE };
  }

  if (argv[0] !== 'session') {
    return invalidCommand();
  }

  if (argv[1] === 'title') {
    return runTitleSubcommand(argv.slice(2), dependencies);
  }

  if (argv[1] === 'import-native') {
    if (argv.length !== 2) {
      return invalidCommand();
    }
    return runImportNativeSubcommand(dependencies);
  }

  return invalidCommand();
}

/** Alias kept concise for standalone callers and focused command tests. */
export const runSessionTitleAnnotationCommand =
  executeSessionTitleAnnotationCommand;
