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

const BRAIN_SESSION_ID_RE =
  /[\\/]brain[\\/]([^\\/]+)[\\/]\.system_generated[\\/]logs[\\/]transcript\.jsonl$/;
const BRAIN_INLINE_ID_RE =
  /\.gemini[\\/]antigravity-cli[\\/]brain[\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[\\/]/i;

const ANTIGRAVITY_SOURCES = new Set(['USER_EXPLICIT', 'MODEL', 'SYSTEM']);
const ANTIGRAVITY_STEP_TYPES = new Set([
  'USER_INPUT',
  'PLANNER_RESPONSE',
  'GENERIC',
  'SYSTEM_MESSAGE',
  'EPHEMERAL_MESSAGE',
]);

function emptyTokens(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

function unwrapStringArg(value: unknown): string | undefined {
  const str = asString(value);
  if (str === undefined) return undefined;
  const trimmed = str.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Keep original string when not valid JSON string literal.
    }
  }
  return str;
}

const USER_REQUEST_OPEN_TAG = '<USER_REQUEST>';
const USER_REQUEST_CLOSE_TAG = '</USER_REQUEST>';

export function extractAntigravityUserRequest(content: string): string {
  const openIdx = content.indexOf(USER_REQUEST_OPEN_TAG);
  if (openIdx === -1) return content.trim();
  const bodyStart = openIdx + USER_REQUEST_OPEN_TAG.length;
  const closeIdx = content.indexOf(USER_REQUEST_CLOSE_TAG, bodyStart);
  if (closeIdx === -1) return content.trim();
  return content.slice(bodyStart, closeIdx).trim();
}

function cleanUserInputForTitle(content: string): string | undefined {
  if (content.includes('<CONTEXT_SUMMARY>')) return undefined;
  const body = extractAntigravityUserRequest(content);
  if (!body) return undefined;
  return body;
}

function looksLikeAntigravityLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  try {
    const raw = asRecord(JSON.parse(trimmed));
    if (!raw) return false;
    const stepIndex = asNumber(raw['step_index']);
    const source = asString(raw['source']);
    const stepType = asString(raw['type']);
    return (
      stepIndex !== undefined &&
      source !== undefined &&
      ANTIGRAVITY_SOURCES.has(source) &&
      stepType !== undefined &&
      ANTIGRAVITY_STEP_TYPES.has(stepType)
    );
  } catch {
    return false;
  }
}

function extractSessionIdFromPath(
  filePath: string | undefined,
): string | undefined {
  if (!filePath) return undefined;
  const match = filePath.match(BRAIN_SESSION_ID_RE);
  if (match && isSafeIdentifier(match[1])) {
    return match[1];
  }
  return undefined;
}

function isSuccessfulShellOutput(
  status: string | undefined,
  content: string,
): boolean {
  if (status === 'ERROR') return false;
  const exitMatch = content.match(/Command exited with code (\d+)\./);
  if (exitMatch && Number(exitMatch[1]) !== 0) {
    return false;
  }
  return true;
}

/** Reduces Antigravity CLI brain transcript.jsonl without retaining message bodies. */
export const antigravityAdapter: TranscriptAdapter = {
  agent: 'antigravity',
  detect(firstLines: string[], filePath: string): boolean {
    if (extractSessionIdFromPath(filePath) !== undefined) {
      return true;
    }
    return firstLines.some(looksLikeAntigravityLine);
  },
  reduce(lines: Iterable<string>, filePath?: string): SessionSummary[] {
    if (filePath?.endsWith('transcript_full.jsonl')) {
      return [];
    }
    let sessionId = extractSessionIdFromPath(filePath);
    let cwd: string | undefined;
    let model: string | undefined;
    let startedAt: string | undefined;
    let lastActivityAt: string | undefined;
    let title: string | undefined;
    let turns = 0;
    const tokens = emptyTokens();
    let lastToolCall: SessionSummary['lastToolCall'];
    const toolCallCounts: Record<string, number> = {};
    const prNumbers = new Set<number>();
    const qualifiedPRs = new Map<string, QualifiedSessionPR>();
    const commitShas = new Set<string>();
    let pendingCreatingResults: boolean[] = [];
    let sawAntigravityStep = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const raw = asRecord(parsed);
      if (!raw) continue;

      const source = asString(raw['source']);
      const stepType = asString(raw['type']);
      const stepIndex = asNumber(raw['step_index']);
      if (
        stepIndex === undefined ||
        !source ||
        !ANTIGRAVITY_SOURCES.has(source) ||
        !stepType ||
        !ANTIGRAVITY_STEP_TYPES.has(stepType)
      ) {
        continue;
      }
      sawAntigravityStep = true;

      const explicitId =
        asString(raw['conversationId']) ??
        asString(raw['conversation_id']) ??
        asString(raw['session_id']) ??
        asString(raw['sessionId']);
      if (explicitId && isSafeIdentifier(explicitId)) {
        sessionId = explicitId;
      }

      const explicitCwd = asString(raw['cwd']);
      if (explicitCwd) cwd = explicitCwd;
      const explicitModel =
        asString(raw['model']) ?? asString(raw['modelName']);
      if (explicitModel) model = explicitModel;

      const timestamp =
        asString(raw['created_at']) ?? asString(raw['timestamp']);
      if (timestamp) {
        if (!startedAt || timestamp < startedAt) startedAt = timestamp;
        if (!lastActivityAt || timestamp > lastActivityAt) {
          lastActivityAt = timestamp;
        }
      }

      const content = asString(raw['content']) ?? '';
      if (!sessionId && content) {
        const inlineMatch = content.match(BRAIN_INLINE_ID_RE);
        if (inlineMatch && isSafeIdentifier(inlineMatch[1])) {
          sessionId = inlineMatch[1];
        }
      }

      if (stepType === 'USER_INPUT' && source === 'USER_EXPLICIT') {
        turns += 1;
        pendingCreatingResults = [];
        if (!title && content) {
          const cleaned = cleanUserInputForTitle(content);
          if (cleaned) {
            title = truncateTitle(cleaned);
          }
        }
      } else if (stepType === 'PLANNER_RESPONSE') {
        pendingCreatingResults = [];
        const inTokens = asNumber(raw['input_tokens']) ?? 0;
        const outTokens = asNumber(raw['output_tokens']) ?? 0;
        const cacheRead = asNumber(raw['cache_read_tokens']) ?? 0;
        const cacheCreate = asNumber(raw['cache_creation_tokens']) ?? 0;
        if (inTokens > 0) tokens.inputTokens += inTokens;
        if (outTokens > 0) tokens.outputTokens += outTokens;
        if (cacheRead > 0) tokens.cacheReadTokens += cacheRead;
        if (cacheCreate > 0) tokens.cacheCreationTokens += cacheCreate;

        const toolCalls = asArray(raw['tool_calls']) ?? [];
        for (const item of toolCalls) {
          const tc = asRecord(item);
          const name = asString(tc?.['name']);
          if (!name) {
            pendingCreatingResults.push(false);
            continue;
          }
          toolCallCounts[name] = (toolCallCounts[name] ?? 0) + 1;
          if (timestamp) {
            lastToolCall = { name, timestamp };
          }
          const args = asRecord(tc?.['args']);
          const command =
            name === 'run_command'
              ? unwrapStringArg(args?.['CommandLine'] ?? args?.['command'])
              : undefined;
          pendingCreatingResults.push(
            Boolean(command && isPRPublicationCommand(command)),
          );
        }
      } else if (stepType === 'GENERIC') {
        const isCreating = pendingCreatingResults.shift() ?? false;
        const status = asString(raw['status']);
        if (isCreating && isSuccessfulShellOutput(status, content)) {
          for (const pr of findQualifiedPRs(content)) {
            qualifiedPRs.set(
              `${pr.repo.owner}/${pr.repo.name}#${pr.number}`,
              pr,
            );
          }
        }
      }

      const deliverables = findDeliverables(raw);
      for (const number of deliverables.prNumbers) prNumbers.add(number);
      for (const sha of deliverables.commitShas) commitShas.add(sha);
    }

    if (!sawAntigravityStep) return [];
    const resolvedSessionId =
      sessionId && isSafeIdentifier(sessionId)
        ? sessionId
        : 'antigravity-session';

    return [
      {
        sessionId: resolvedSessionId,
        source: 'cli',
        agent: 'antigravity',
        ...(cwd && { cwd }),
        ...(model && { model }),
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
