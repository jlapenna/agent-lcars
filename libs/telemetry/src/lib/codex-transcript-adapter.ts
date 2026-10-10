import {
  findDeliverables,
  findQualifiedPRs,
  isPRPublicationCommand,
} from './deliverables';
import type { TranscriptAdapter } from './transcript-adapter-types';
import { type QualifiedSessionPR, SessionSummary, TokenUsage } from './types';
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  isSafeIdentifier,
  truncateTitle,
} from './unknown-value';

/** Codex records exec stdout inside a JSON result envelope. Code-mode
 * orchestration can add prose plus one envelope per line. Decode only known
 * stdout envelopes; unrelated metadata does not become publication evidence. */
function publicationOutput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const outputs: unknown[] = [];
  let recognized = false;
  for (const candidate of [value, ...value.split('\n')]) {
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = asRecord(JSON.parse(candidate));
    } catch {
      continue;
    }
    if (parsed && 'output' in parsed) {
      recognized = true;
      // A recognized failed result is not publication evidence.
      if (parsed['exit_code'] === undefined || parsed['exit_code'] === 0)
        outputs.push(parsed['output']);
      if (candidate === value) return outputs;
    }
  }
  return recognized ? outputs : value;
}

function emptyTokens(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
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

function userMessageText(payload: Record<string, unknown>): string | undefined {
  const legacyMessage = asString(payload['message']);
  if (legacyMessage) return legacyMessage;

  const content = asArray(payload['content']);
  if (!content) return undefined;
  for (const item of content) {
    const block = asRecord(item);
    if (
      block &&
      (asString(block['type']) === 'input_text' ||
        asString(block['type']) === 'text')
    ) {
      const text = asString(block['text']);
      if (text) return text;
    }
  }
  return undefined;
}

/** Codex prepends repository instructions as a user-role input. They are
 * context, not the user's task, so using them as a session title produces a
 * misleading label and hides the first real request. */
function isInjectedRepositoryInstructions(message: string): boolean {
  return (
    message.startsWith('# AGENTS.md instructions') &&
    message.includes('<INSTRUCTIONS>')
  );
}

/** Reduces Codex CLI rollout JSONL without retaining message bodies. */
export const codexAdapter: TranscriptAdapter = {
  agent: 'codex',
  detect(firstLines: string[]): boolean {
    return firstLines.some(looksLikeCodexLine);
  },
  reduce(lines: Iterable<string>): SessionSummary[] {
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
    const qualifiedPRs = new Map<string, QualifiedSessionPR>();
    const creatingCalls = new Set<string>();
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
          const message = userMessageText(payload);
          if (message && !isInjectedRepositoryInstructions(message)) {
            title = truncateTitle(message);
          }
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
      } else if (
        lineType === 'response_item' &&
        payloadType === 'message' &&
        asString(payload['role']) === 'user' &&
        !title
      ) {
        const message = userMessageText(payload);
        if (message && !isInjectedRepositoryInstructions(message)) {
          title = truncateTitle(message);
        }
      }

      // Keep historical display hints, but financial attribution requires a
      // qualified URL from the correlated result of a creating command.
      if (lineType === 'response_item') {
        const callId = asString(payload['call_id']);
        if (
          callId &&
          (payloadType === 'function_call' ||
            payloadType === 'custom_tool_call')
        ) {
          const input = payload['arguments'] ?? payload['input'];
          const command =
            typeof input === 'string' ? input : JSON.stringify(input);
          const toolName = asString(payload['name']);
          if (
            toolName &&
            [
              'exec',
              'exec_command',
              'functions.exec',
              'functions.exec_command',
              'shell',
              'Bash',
              'bash',
            ].includes(toolName) &&
            command &&
            isPRPublicationCommand(command)
          )
            creatingCalls.add(callId);
        } else if (
          callId &&
          creatingCalls.has(callId) &&
          (payloadType === 'function_call_output' ||
            payloadType === 'custom_tool_call_output')
        ) {
          creatingCalls.delete(callId);
          for (const pr of findQualifiedPRs(
            publicationOutput(payload['output']),
          ))
            qualifiedPRs.set(
              `${pr.repo.owner}/${pr.repo.name}#${pr.number}`,
              pr,
            );
        }
      }
      const deliverables = findDeliverables(raw);
      for (const number of deliverables.prNumbers) prNumbers.add(number);
      for (const sha of deliverables.commitShas) commitShas.add(sha);
    }

    if (!sessionId || !isSafeIdentifier(sessionId)) return [];
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
        ...(title && { title, titleSource: 'inferred' as const }),
        deliverables: {
          prNumbers: Array.from(prNumbers),
          ...(qualifiedPRs.size > 0 && {
            qualifiedPRs: [...qualifiedPRs.values()],
          }),
          commitShas: Array.from(commitShas),
        },
      },
    ];
  },
};
