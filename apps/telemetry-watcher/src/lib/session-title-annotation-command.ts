import { isSafeIdentifier } from '@agent-lcars/telemetry';

import {
  clearSessionTitleAnnotation,
  SessionTitleAnnotationWriterDependencies,
  writeSessionTitleAnnotation,
} from './session-title-annotation-writer';

export interface SessionTitleAnnotationCommandDependencies extends SessionTitleAnnotationWriterDependencies {
  env?: NodeJS.ProcessEnv;
}

export interface SessionTitleAnnotationCommandResult {
  readonly ok: boolean;
  /** A deliberately generic, non-secret diagnostic suitable for CLI output. */
  readonly error?: 'invalid-command' | 'invalid-session' | 'write-failed';
}

/**
 * Executes the intentionally narrow `session title` command contract.
 * Directory and session discovery are not command inputs: the session id is
 * supplied only by LCARS_SESSION_ID.
 */
export function executeSessionTitleAnnotationCommand(
  argv: readonly string[],
  dependencies: SessionTitleAnnotationCommandDependencies = {},
): SessionTitleAnnotationCommandResult {
  const sessionId = dependencies.env
    ? dependencies.env.LCARS_SESSION_ID
    : process.env.LCARS_SESSION_ID;
  if (!sessionId || !isSafeIdentifier(sessionId)) {
    return { ok: false, error: 'invalid-session' };
  }

  if (argv.length < 2 || argv[0] !== 'session' || argv[1] !== 'title') {
    return { ok: false, error: 'invalid-command' };
  }
  const commandArgs = argv.slice(2);

  if (commandArgs.length === 1 && commandArgs[0] === '--clear') {
    return clearSessionTitleAnnotation(sessionId, dependencies).ok
      ? { ok: true }
      : { ok: false, error: 'write-failed' };
  }

  if (
    commandArgs.length !== 1 ||
    commandArgs[0].startsWith('--') ||
    commandArgs[0].length === 0
  ) {
    return { ok: false, error: 'invalid-command' };
  }

  return writeSessionTitleAnnotation(sessionId, commandArgs[0], dependencies).ok
    ? { ok: true }
    : { ok: false, error: 'write-failed' };
}

/** Alias kept concise for standalone callers and focused command tests. */
export const runSessionTitleAnnotationCommand =
  executeSessionTitleAnnotationCommand;
