import { isSafeIdentifier } from '@agent-lcars/telemetry';

/**
 * Session id environment variables, in resolution-order preference. Both
 * `CLAUDE_CODE_SESSION_ID` and `CODEX_THREAD_ID` are confirmed present in
 * every tool-call environment on a real host (Claude Code and Codex each
 * set their own), so no hook, wrapper, or model-supplied id is needed to
 * populate them. `LCARS_SESSION_ID` exists purely as an explicit manual
 * override, checked first, for a human or a runtime neither of the other
 * two recognizes.
 */
export const SESSION_ID_ENV_VARS = [
  'LCARS_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_THREAD_ID',
] as const;

export type SessionIdEnvVar = (typeof SESSION_ID_ENV_VARS)[number];

/** Discriminated so a caller can tell "nothing set at all" apart from "the
 * first candidate present is unsafe" -- the two have different meanings
 * (absence vs. a value this process refuses to trust) even though today's
 * only caller, `session-title-annotation-command.ts`, collapses both into
 * the same generic CLI diagnostic. */
export type SessionIdResolution =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly source: SessionIdEnvVar;
    }
  | { readonly ok: false; readonly reason: 'unset' }
  | {
      readonly ok: false;
      readonly reason: 'unsafe';
      readonly source: SessionIdEnvVar;
    };

/**
 * Resolves the current session id from the environment, in
 * `SESSION_ID_ENV_VARS` order.
 *
 * The FIRST variable that is present (set, even to an unsafe value) wins
 * outright -- presence alone stops the search. If that value fails
 * `isSafeIdentifier`, resolution fails there and does NOT fall through to
 * the next variable. Falling through would let a malformed id in one
 * runtime silently retarget a different runtime's session (e.g. a
 * corrupted `LCARS_SESSION_ID` silently resolving to whatever
 * `CLAUDE_CODE_SESSION_ID` happens to hold) -- worse than simply failing.
 *
 * `env` defaults to the real `process.env` only when the argument is
 * omitted entirely. A caller that explicitly injects an env object (tests,
 * or any dependency-injecting wrapper) gets exactly that object and never
 * an implicit merge with the real environment.
 */
export function resolveSessionId(
  env: NodeJS.ProcessEnv = process.env,
): SessionIdResolution {
  for (const source of SESSION_ID_ENV_VARS) {
    const value = env[source];
    if (value === undefined) continue;
    return isSafeIdentifier(value)
      ? { ok: true, sessionId: value, source }
      : { ok: false, reason: 'unsafe', source };
  }
  return { ok: false, reason: 'unset' };
}
