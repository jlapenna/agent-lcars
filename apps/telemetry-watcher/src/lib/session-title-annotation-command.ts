import { resolveSessionId } from './session-id';
import {
  clearSessionStatusAnnotation,
  clearSessionTitleAnnotation,
  pruneStaleDeclaredSessionTitleAnnotations,
  pruneStaleSessionStatusAnnotations,
  SessionTitleAnnotationWriterDependencies,
  SessionTitleAnnotationWriterResult,
  writeSessionStatusAnnotation,
  writeSessionTitleAnnotation,
} from './session-title-annotation-writer';
import { DECLARED_TITLE_SUBDIRECTORY } from './session-title-paths';

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
  'usage: session title "<text>" | session title --clear | session status "<text>" | session status --clear | session prune';

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

/**
 * Shared grammar for `session title` and `session status`: both are
 * `"<text>"` | `--clear`, resolving the current session id the same way,
 * differing only in which write/clear function backs the text field
 * (`title` writes into one of two tiered channels and so still needs a
 * `channel` bound in via closure at each call site below; `status` has only
 * one channel and takes no such argument at all — see
 * `writeSessionStatusAnnotation`'s own doc comment for why). Factored out
 * (issue #1257) so the grammar/dispatch logic itself — argument-count and
 * flag checks, session-id resolution, the generic `write-failed` mapping —
 * exists in exactly one place rather than two copies that could drift.
 */
function runTextFieldSubcommand(
  commandArgs: readonly string[],
  dependencies: SessionTitleAnnotationCommandDependencies,
  write: (
    sessionId: string,
    text: string,
    dependencies: SessionTitleAnnotationCommandDependencies,
  ) => SessionTitleAnnotationWriterResult,
  clear: (
    sessionId: string,
    dependencies: SessionTitleAnnotationCommandDependencies,
  ) => SessionTitleAnnotationWriterResult,
): SessionTitleAnnotationCommandResult {
  const resolution = resolveSessionId(dependencies.env);
  if (!resolution.ok) {
    return { ok: false, error: 'invalid-session' };
  }
  const sessionId = resolution.sessionId;

  if (commandArgs.length === 1 && commandArgs[0] === '--clear') {
    return clear(sessionId, dependencies).ok
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

  return write(sessionId, commandArgs[0], dependencies).ok
    ? { ok: true }
    : { ok: false, error: 'write-failed' };
}

function runTitleSubcommand(
  commandArgs: readonly string[],
  dependencies: SessionTitleAnnotationCommandDependencies,
): SessionTitleAnnotationCommandResult {
  return runTextFieldSubcommand(
    commandArgs,
    dependencies,
    (sessionId, text, deps) =>
      writeSessionTitleAnnotation(
        sessionId,
        text,
        DECLARED_TITLE_SUBDIRECTORY,
        deps,
      ),
    (sessionId, deps) =>
      clearSessionTitleAnnotation(sessionId, DECLARED_TITLE_SUBDIRECTORY, deps),
  );
}

/**
 * What the agent says it is doing RIGHT NOW — `session status "<text>"` /
 * `session status --clear` (issue #1257). Session id resolution is the
 * exact same shared machinery `session title` uses (see
 * `runTextFieldSubcommand`); only the underlying channel differs.
 */
function runStatusSubcommand(
  commandArgs: readonly string[],
  dependencies: SessionTitleAnnotationCommandDependencies,
): SessionTitleAnnotationCommandResult {
  return runTextFieldSubcommand(
    commandArgs,
    dependencies,
    writeSessionStatusAnnotation,
    clearSessionStatusAnnotation,
  );
}

/** Removes expired explicit annotations. This has no Codex dependency and
 * deliberately needs no current session id, so a low-frequency host timer
 * can keep the two bounded reader directories available. */
function runPruneSubcommand(
  dependencies: SessionTitleAnnotationCommandDependencies,
): SessionTitleAnnotationCommandResult {
  pruneStaleDeclaredSessionTitleAnnotations(dependencies);
  pruneStaleSessionStatusAnnotations(dependencies);
  return { ok: true };
}

/**
 * Executes the `session` command's title and status subcommands: `session title
 * "<text>"`, `session title --clear`, `session status "<text>"` / `session
 * status --clear`, and `session prune`. Directory selection is never a
 * command input -- each subcommand's channel is fixed by which one it is.
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

  if (argv[1] === 'status') {
    return runStatusSubcommand(argv.slice(2), dependencies);
  }

  if (argv[1] === 'prune' && argv.length === 2) {
    return runPruneSubcommand(dependencies);
  }

  return invalidCommand();
}
