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

/** Anything carrying the optional `renderable` field — today only
 * {@link IssueAgentSessionDoc}, but typed structurally (like
 * {@link HasSessionAgent}) rather than importing that type directly, so
 * this stays usable from a plain `{ agent, renderable }` test fixture. */
export interface HasRenderableFlag {
  renderable?: boolean;
}

/**
 * Resolves whether a session's archived transcript (`transcriptGcsUri`) can
 * be rendered as a timeline, reading the `renderable` field
 * `buildSessionDoc` sets once at capture time (session-doc.ts) rather than
 * re-deriving it — this is the read side of #645's `TelemetrySessionRef`
 * contract (`renderable`, set once by Worker runtime, read by the console).
 *
 * Falls back to the pre-#645 gate (`sessionAgent(doc) === 'claude-code'`)
 * only when `renderable` itself is absent: every doc shipped before this
 * field existed has no opinion of its own, and treating that absence as
 * "not renderable" would blank out every already-shipped Claude Code
 * session's timeline the moment this ships, not just the Codex/OpenCode
 * ones the flag exists to gate. This is a one-time migration shim for
 * already-stored docs, not an ongoing derivation path — every doc
 * `buildSessionDoc` writes going forward carries its own `renderable`
 * value, so this fallback branch only ever applies to docs older than this
 * change.
 */
export function isSessionRenderable(
  source: HasSessionAgent & HasRenderableFlag,
): boolean {
  return source.renderable ?? sessionAgent(source) === 'claude-code';
}
