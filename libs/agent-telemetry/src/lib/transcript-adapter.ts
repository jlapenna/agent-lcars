import { codexAdapter } from './codex-transcript-adapter';
import { reduceTranscriptLines } from './reducer';
import { TranscriptAdapter } from './transcript-adapter-types';
import { SessionAgent, SessionSummary } from './types';
import { asRecord } from './unknown-value';

export { codexAdapter } from './codex-transcript-adapter';
export type { TranscriptAdapter } from './transcript-adapter-types';

/**
 * The seam phase 2/3 of #3123 build on to add non-Claude-Code agents to the
 * telemetry pipeline: one adapter per agent, each owning both "is this file
 * mine?" detection and the actual parse. `reduceTranscript`/`reduceTranscripts`
 * (reducer.ts) remain the standalone, unchanged entry point for every
 * existing Claude-Code-only caller (the CLI's `agent-telemetry reduce`
 * command, the watcher's runner ride-along mode, and the console's
 * transcript-timeline detail view) — this interface wraps that reducer for
 * `claudeCodeAdapter` rather than replacing it, and exists purely so the
 * watcher's multi-root config (apps/agent-telemetry-watcher) can resolve
 * "this root holds `<agent>` transcripts" to a concrete parser by name
 * instead of hardcoding Claude Code's reducer as the only option.
 *
 * To add a new agent: implement this interface (`detect` should be a cheap,
 * tolerant sniff of a handful of lines — false positives just mean a file
 * gets mis-parsed into an empty/malformed summary, not a crash, since
 * `reduce` must itself tolerate unrecognized content the same way the
 * existing reducer ignores unknown line types) and add it to
 * {@link TRANSCRIPT_ADAPTERS}.
 */
/** Whether a trimmed, non-empty line parses as a JSON object carrying a
 * `sessionId` string — the one field every Claude Code transcript line
 * (`user`/`assistant`/`result`/etc.) is keyed on, per `reducer.ts`. This is
 * deliberately loose (no check on `type`/`message`/`uuid`) so it stays
 * tolerant of transcript format drift the way the reducer itself is; the
 * cost of that looseness is only relevant once a second adapter exists to
 * conflict with, which none currently do. */
function looksLikeClaudeCodeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  const record = asRecord(parsed);
  return typeof record?.['sessionId'] === 'string';
}

export const claudeCodeAdapter: TranscriptAdapter = {
  agent: 'claude-code',
  detect(firstLines: string[]): boolean {
    return firstLines.some(looksLikeClaudeCodeLine);
  },
  reduce(lines: string[]): SessionSummary[] {
    // reduceTranscriptLines (not reduceTranscript) - lines are already
    // split, so going through the string-based API would force a wasteful
    // join-then-resplit round trip on every file, every tick. See
    // reducer.ts's reduceLines doc comment.
    return reduceTranscriptLines(lines);
  },
};

/** Every registered adapter, in priority order (earliest match wins in
 * {@link adapterFor}). Claude Code is the only one implemented as of #3123
 * phase 1 — see {@link SessionAgent}'s doc comment for the others this
 * registry is expected to grow. */
export const TRANSCRIPT_ADAPTERS: TranscriptAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
];

/**
 * Content-sniffing lookup: the first registered adapter whose `detect`
 * matches, or `undefined` if none do. For the watcher's multi-root config,
 * where the operator already declares which agent a root holds, prefer
 * {@link getTranscriptAdapter} (name-keyed) instead — this is for contexts
 * with an unlabeled file and no config to consult.
 */
export function adapterFor(
  firstLines: string[],
  filePath: string,
): TranscriptAdapter | undefined {
  return TRANSCRIPT_ADAPTERS.find((adapter) =>
    adapter.detect(firstLines, filePath),
  );
}

/** Name-keyed lookup: the registered adapter for a given {@link SessionAgent},
 * or `undefined` if none is registered yet (e.g. every non-`claude-code`
 * value today). Used by the watcher to resolve a configured watch root's
 * declared `adapter` to the parser that actually reduces its files. */
export function getTranscriptAdapter(
  agent: SessionAgent,
): TranscriptAdapter | undefined {
  return TRANSCRIPT_ADAPTERS.find((adapter) => adapter.agent === agent);
}
