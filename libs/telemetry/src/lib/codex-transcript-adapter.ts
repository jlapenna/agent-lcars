import { findDeliverables } from './deliverables';
import type { TranscriptAdapter } from './transcript-adapter-types';
import { SessionSummary, TokenUsage } from './types';
import { asNumber, asRecord, asString } from './unknown-value';

const TITLE_MAX_LENGTH = 80;

function emptyTokens(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

function truncateTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > TITLE_MAX_LENGTH
    ? `${collapsed.slice(0, TITLE_MAX_LENGTH - 1)}…`
    : collapsed;
}

function looksLikeCodexLine(line: string): boolean {
  try {
    const raw = asRecord(JSON.parse(line));
    const payload = raw && asRecord(raw['payload']);
    return (
      asString(raw?.['type']) === 'session_meta' &&
      typeof payload?.['id'] === 'string' &&
      typeof payload?.['originator'] === 'string'
    );
  } catch {
    return false;
  }
}

/** Reduces Codex CLI rollout JSONL without retaining message bodies. */
export const codexAdapter: TranscriptAdapter = {
  agent: 'codex',
  detect(firstLines: string[]): boolean {
    return firstLines.some(looksLikeCodexLine);
  },
  reduce(lines: string[]): SessionSummary[] {
    let sessionId: string | undefined;
    let cwd: string | undefined;
    let model: string | undefined;
    let permissionMode: string | undefined;
    let startedAt: string | undefined;
    let lastActivityAt: string | undefined;
    let title: string | undefined;
    let turns = 0;
    let tokens = emptyTokens();
    let lastToolCall: SessionSummary['lastToolCall'];
    const toolCallCounts: Record<string, number> = {};
    const prNumbers = new Set<number>();
    const commitShas = new Set<string>();

    for (const line of lines) {
      if (!line.trim()) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const raw = asRecord(parsed);
      const payload = raw && asRecord(raw['payload']);
      if (!raw || !payload) continue;

      const timestamp = asString(raw['timestamp']);
      if (timestamp) {
        if (!startedAt || timestamp < startedAt) startedAt = timestamp;
        if (!lastActivityAt || timestamp > lastActivityAt) {
          lastActivityAt = timestamp;
        }
      }

      const lineType = asString(raw['type']);
      const payloadType = asString(payload['type']);
      if (lineType === 'session_meta') {
        sessionId =
          asString(payload['id']) ??
          asString(payload['session_id']) ??
          sessionId;
        cwd = asString(payload['cwd']) ?? cwd;
      } else if (lineType === 'turn_context') {
        cwd = asString(payload['cwd']) ?? cwd;
        model = asString(payload['model']) ?? model;
        permissionMode = asString(payload['approval_policy']) ?? permissionMode;
      } else if (lineType === 'event_msg') {
        if (payloadType === 'task_started') turns += 1;
        if (payloadType === 'user_message' && !title) {
          const message = asString(payload['message']);
          if (message) title = truncateTitle(message);
        }
        if (payloadType === 'token_count') {
          const info = asRecord(payload['info']);
          const total = info && asRecord(info['total_token_usage']);
          if (total) {
            // Codex/OpenAI reports cached input as a subset of input_tokens,
            // unlike Claude's mutually exclusive usage fields. Normalize to
            // the shared TokenUsage contract so input + output means fresh
            // tokens for either agent and cache reads are not counted twice.
            const inclusiveInput = asNumber(total['input_tokens']) ?? 0;
            const cachedInput = asNumber(total['cached_input_tokens']) ?? 0;
            tokens = {
              inputTokens: Math.max(0, inclusiveInput - cachedInput),
              outputTokens: asNumber(total['output_tokens']) ?? 0,
              cacheCreationTokens: 0,
              cacheReadTokens: cachedInput,
            };
          }
        }
      } else if (
        lineType === 'response_item' &&
        payloadType === 'custom_tool_call'
      ) {
        const name = asString(payload['name']);
        if (name) {
          toolCallCounts[name] = (toolCallCounts[name] ?? 0) + 1;
          if (timestamp) lastToolCall = { name, timestamp };
        }
      }

      const deliverables = findDeliverables(raw);
      for (const number of deliverables.prNumbers) prNumbers.add(number);
      for (const sha of deliverables.commitShas) commitShas.add(sha);
    }

    if (!sessionId) return [];
    return [
      {
        sessionId,
        source: 'cli',
        agent: 'codex',
        ...(cwd && { cwd }),
        ...(model && { model }),
        ...(permissionMode && { permissionMode }),
        startedAt: startedAt ?? '',
        lastActivityAt: lastActivityAt ?? '',
        turns,
        toolCallCounts,
        tokens,
        ...(lastToolCall && { lastToolCall }),
        ...(title && { title }),
        deliverables: {
          prNumbers: Array.from(prNumbers),
          commitShas: Array.from(commitShas),
        },
      },
    ];
  },
};
