import { SessionAgent } from './types';

/** Anything carrying the optional `agent` field — {@link SessionSummary} and
 * every {@link SessionDoc} variant structurally satisfy this without a cast. */
export interface HasSessionAgent {
  agent?: SessionAgent;
}

/**
 * Resolves the effective {@link SessionAgent} for a summary or doc, defaulting
 * to `'claude-code'` when the field is absent — every session shipped before
 * #3123 (and any fixture/test object that predates it) has no `agent` field
 * at all, and all of them are Claude Code sessions by construction (it was
 * the only reducer that ever existed). Every consumer — the console
 * especially — must call this instead of reading `.agent` directly, so a
 * legacy doc renders identically to a freshly-reduced `agent: 'claude-code'`
 * one rather than as some third "unknown" state.
 */
export function sessionAgent(source: HasSessionAgent): SessionAgent {
  return source.agent ?? 'claude-code';
}
