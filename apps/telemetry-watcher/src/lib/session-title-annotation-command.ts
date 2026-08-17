import {
  pollCodexNativeTitles,
  resolveCodexStateDbPath,
} from './codex-native-title-source';
import { resolveSessionId } from './session-id';
import {
  clearSessionStatusAnnotation,
  clearSessionTitleAnnotation,
  pruneGeneratedSessionTitleAnnotations,
  pruneStaleDeclaredSessionTitleAnnotations,
  pruneStaleSessionStatusAnnotations,
  SessionTitleAnnotationWriterDependencies,
  SessionTitleAnnotationWriterResult,
  writeSessionStatusAnnotation,
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
  'usage: session title "<text>" | session title --clear | session status "<text>" | session status --clear | session import-native';

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
 * was there before. Pruning below is the same story: rerunning with an
 * unchanged selected set deletes nothing, because every existing final is
 * already in the keep set.
 *
 * Fails soft throughout, matching `pollCodexNativeTitles`'s own contract:
 * an absent/locked/schema-mismatched DB is the common case (most hosts
 * don't run Codex, or a live Codex process holds a brief lock) and is
 * reported as `{ ok: true }` with nothing imported, never as a command
 * failure. A single row that fails to write does not stop its siblings.
 *
 * Write-then-prune, in that order (issue #1224): `pollCodexNativeTitles`
 * already bounds a single run's own writes (recency window + hard cap,
 * newest first), but never removes what an *earlier* run wrote and this
 * run's window/cap no longer selects -- left alone, the generated
 * directory would still accumulate past the reader's
 * `MAX_SESSION_TITLE_ANNOTATION_FILES` cap within a month as the selected
 * set rotates. `pruneGeneratedSessionTitleAnnotations` closes that gap by
 * deleting every generated-channel final not in this run's keep set.
 *
 * Pruning is gated on `dbAvailable`, deliberately distinct from "zero
 * candidates this run": those are different facts, exactly the same
 * `available` vs. "available but empty" distinction
 * `readSessionTitleDirectory` draws on the read side. A DB that opened and
 * queried cleanly but had nothing in the window is a real "nothing to
 * import right now" -- pruning to match that (down to empty, if that's
 * what the window says) is correct. A DB that couldn't be opened or
 * queried at all is a transient failure with an empty `candidates` for an
 * entirely different reason, and must NOT be allowed to prune away
 * everything a previous, successful run wrote -- that would turn a brief
 * lock or a not-yet-installed CLI into a data-loss event instead of the
 * no-op it should be.
 *
 * The `declared` channel's own age-based pruning
 * (`pruneStaleDeclaredSessionTitleAnnotations`) runs unconditionally,
 * Codex DB or not -- see that function's doc comment for why it lives
 * here at all.
 */
function runImportNativeSubcommand(
  dependencies: SessionTitleAnnotationCommandDependencies,
): SessionTitleAnnotationCommandResult {
  const dbPath = resolveCodexStateDbPath({
    env: dependencies.env,
    homeDirectory: dependencies.homeDirectory,
  });
  if (dbPath) {
    let dbAvailable = true;
    const candidates = pollCodexNativeTitles(dbPath, {
      now: dependencies.now,
      onUnavailable: () => {
        dbAvailable = false;
      },
    });
    for (const candidate of candidates) {
      writeSessionTitleAnnotation(
        candidate.sessionId,
        candidate.title,
        GENERATED_TITLE_SUBDIRECTORY,
        dependencies,
      );
    }
    if (dbAvailable) {
      pruneGeneratedSessionTitleAnnotations(
        new Set(candidates.map((candidate) => candidate.sessionId)),
        dependencies,
      );
    }
  }
  // The status channel is bounded and pruned the same way (age-based,
  // CLI_SESSION_RETENTION_DAYS), from the same host-side maintenance pass,
  // unconditionally (Codex DB or not) -- see
  // pruneStaleSessionStatusAnnotations's own doc comment for why this must
  // never be able to overflow the reader's MAX_SESSION_TITLE_ANNOTATION_FILES
  // cap.
  pruneStaleDeclaredSessionTitleAnnotations(dependencies);
  pruneStaleSessionStatusAnnotations(dependencies);
  return { ok: true };
}

/**
 * Executes the `session` command's four subcommands: `session title
 * "<text>"`, `session title --clear`, `session status "<text>"` / `session
 * status --clear`, and `session import-native`. Directory selection is
 * never a command input -- each subcommand's channel is fixed by which one
 * it is.
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

  if (argv[1] === 'import-native') {
    if (argv.length !== 2) {
      return invalidCommand();
    }
    return runImportNativeSubcommand(dependencies);
  }

  return invalidCommand();
}
