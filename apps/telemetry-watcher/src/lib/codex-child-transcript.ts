import {
  codexAdapter,
  isSafeIdentifier,
  type SessionSummary,
} from '@agent-lcars/telemetry';

/** Codex fork rollouts can carry the parent's metadata and history before
 * their own thread begins. Independent children start at their own metadata;
 * forks start at the identity-matched child suffix. Only explicit child
 * thread counters belong to the child's summary. Missing or
 * ambiguous ownership remains uncollected rather than billed as a new session. */
export function reduceCodexChildTranscript(
  readLines: () => Iterable<string>,
  sessionId: string,
  expectedParentId: string | undefined,
): SessionSummary | undefined {
  if (!expectedParentId) return undefined;
  try {
    const ownedLines: string[] = [];
    let parentId: string | undefined;
    let expectedAncestor: string | undefined;
    let ownThread = false;
    let usage: SessionSummary['tokens'] | undefined;
    let inclusiveInput = 0;
    for (const line of readLines()) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as {
        type?: unknown;
        payload?: {
          id?: unknown;
          type?: unknown;
          thread_id?: unknown;
          forked_from_id?: unknown;
          source?: {
            subagent?: { thread_spawn?: { parent_thread_id?: unknown } };
          };
          thread_token_usage?: {
            input_tokens?: unknown;
            output_tokens?: unknown;
            cached_input_tokens?: unknown;
          };
        };
      };
      const payload = row?.payload;
      if (!parentId) {
        const parent =
          payload?.source?.subagent?.thread_spawn?.parent_thread_id;
        if (
          row?.type !== 'session_meta' ||
          payload?.id !== sessionId ||
          typeof parent !== 'string' ||
          !isSafeIdentifier(parent) ||
          parent === sessionId ||
          parent !== expectedParentId ||
          (payload?.forked_from_id !== undefined &&
            payload.forked_from_id !== parent)
        )
          return undefined;
        parentId = parent;
        expectedAncestor = parent;
        // A child spawned without inherited history has no fork marker or
        // initial thread_settings_applied event. Its exact session metadata
        // starts ownership; any later foreign metadata still fails closed.
        ownThread = payload.forked_from_id === undefined;
        ownedLines.push(line);
        continue;
      }
      if (!ownThread) {
        if (row?.type === 'session_meta') {
          if (!expectedAncestor || payload?.id !== expectedAncestor)
            return undefined;
          const ancestor = payload.forked_from_id;
          expectedAncestor =
            typeof ancestor === 'string' && isSafeIdentifier(ancestor)
              ? ancestor
              : undefined;
        }
        if (
          row?.type !== 'event_msg' ||
          payload?.type !== 'thread_settings_applied' ||
          payload?.thread_id !== sessionId
        )
          continue;
        ownThread = true;
      }
      if (row?.type === 'session_meta' && payload?.id !== sessionId)
        return undefined;
      if (
        row?.type === 'event_msg' &&
        payload?.type === 'thread_settings_applied' &&
        payload.thread_id !== sessionId
      )
        return undefined;
      if (row?.type === 'token_usage_record') {
        if (payload?.thread_id !== sessionId) return undefined;
        const total = payload?.thread_token_usage;
        const input = total?.input_tokens;
        const output = total?.output_tokens;
        const cached = total?.cached_input_tokens;
        if (
          typeof input !== 'number' ||
          typeof output !== 'number' ||
          typeof cached !== 'number' ||
          [input, output, cached].some(
            (value) => !Number.isSafeInteger(value) || value < 0,
          ) ||
          cached > input ||
          input < inclusiveInput ||
          output < (usage?.outputTokens ?? 0) ||
          cached < (usage?.cacheReadTokens ?? 0)
        )
          return undefined;
        inclusiveInput = input;
        usage = {
          inputTokens: input - cached,
          outputTokens: output,
          cacheReadTokens: cached,
          cacheCreationTokens: 0,
        };
      }
      ownedLines.push(line);
    }
    if (!ownThread || !usage) return undefined;
    const summary = codexAdapter.reduce(ownedLines)[0];
    return summary?.sessionId === sessionId
      ? { ...summary, tokens: usage }
      : undefined;
  } catch {
    return undefined;
  }
}
