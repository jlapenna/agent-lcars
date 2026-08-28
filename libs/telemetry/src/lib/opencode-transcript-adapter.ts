import { findDeliverables, isDeliverableCommand } from './deliverables';
import type { TranscriptAdapter } from './transcript-adapter-types';
import { SessionSummary, TokenUsage } from './types';
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  isSafeIdentifier,
  truncateTitle,
} from './unknown-value';

function timestamp(value: unknown): string | undefined {
  const milliseconds = asNumber(value);
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return undefined;
  }
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function tokenUsage(value: unknown): TokenUsage | undefined {
  const tokens = asRecord(value);
  if (!tokens) return undefined;
  const cache = asRecord(tokens['cache']);
  return {
    inputTokens: Math.max(0, asNumber(tokens['input']) ?? 0),
    outputTokens: Math.max(0, asNumber(tokens['output']) ?? 0),
    cacheCreationTokens: Math.max(0, asNumber(cache?.['write']) ?? 0),
    cacheReadTokens: Math.max(0, asNumber(cache?.['read']) ?? 0),
  };
}

function emptyTokens(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

function addTokens(total: TokenUsage, value: TokenUsage): void {
  total.inputTokens += value.inputTokens;
  total.outputTokens += value.outputTokens;
  total.cacheCreationTokens += value.cacheCreationTokens;
  total.cacheReadTokens += value.cacheReadTokens;
}

function parseExport(
  lines: Iterable<string>,
): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(Array.from(lines).join('\n')));
  } catch {
    return undefined;
  }
}

/** Reduces the JSON envelope emitted by `opencode export <sessionID>`. */
export const opencodeAdapter: TranscriptAdapter = {
  agent: 'opencode',
  detect(firstLines: string[]): boolean {
    const raw = parseExport(firstLines);
    const info = raw && asRecord(raw['info']);
    return typeof info?.['id'] === 'string' && Array.isArray(raw?.['messages']);
  },
  reduce(lines: Iterable<string>): SessionSummary[] {
    const raw = parseExport(lines);
    const info = raw && asRecord(raw['info']);
    const messages = raw && asArray(raw['messages']);
    const sessionId = asString(info?.['id']);
    if (
      !raw ||
      !info ||
      !messages ||
      !sessionId ||
      !isSafeIdentifier(sessionId)
    ) {
      return [];
    }

    const infoTime = asRecord(info['time']);
    const startedAt = timestamp(infoTime?.['created']) ?? '';
    let lastActivityAt = timestamp(infoTime?.['updated']) ?? startedAt;
    let turns = 0;
    const summedTokens = emptyTokens();
    let measuredMessageTokens = false;
    let measuredMessageCost = false;
    let summedCost = 0;
    let messageModelId: string | undefined;
    let messageProviderId: string | undefined;
    const toolCallCounts: Record<string, number> = {};
    let lastToolCall: SessionSummary['lastToolCall'];
    const prNumbers = new Set<number>();
    const commitShas = new Set<string>();

    for (const messageValue of messages) {
      const message = asRecord(messageValue);
      const messageInfo = message && asRecord(message['info']);
      if (!message || !messageInfo) continue;
      if (asString(messageInfo['role']) === 'user') turns++;
      if (asString(messageInfo['role']) === 'assistant') {
        messageModelId = asString(messageInfo['modelID']) ?? messageModelId;
        messageProviderId =
          asString(messageInfo['providerID']) ?? messageProviderId;
      }

      const messageTime = asRecord(messageInfo['time']);
      const messageActivity =
        timestamp(messageTime?.['completed']) ??
        timestamp(messageTime?.['created']);
      if (
        messageActivity &&
        (!lastActivityAt || messageActivity > lastActivityAt)
      ) {
        lastActivityAt = messageActivity;
      }

      const messageTokens = tokenUsage(messageInfo['tokens']);
      if (messageTokens) {
        measuredMessageTokens = true;
        addTokens(summedTokens, messageTokens);
      }
      const messageCost = asNumber(messageInfo['cost']);
      if (messageCost !== undefined) {
        measuredMessageCost = true;
        summedCost += messageCost;
      }

      for (const partValue of asArray(message['parts']) ?? []) {
        const part = asRecord(partValue);
        if (!part || asString(part['type']) !== 'tool') continue;
        const name = asString(part['tool']);
        if (!name) continue;
        toolCallCounts[name] = (toolCallCounts[name] ?? 0) + 1;

        const state = asRecord(part['state']);
        const stateTime = asRecord(state?.['time']);
        const toolTimestamp =
          timestamp(stateTime?.['end']) ??
          timestamp(stateTime?.['start']) ??
          messageActivity;
        if (
          toolTimestamp &&
          (!lastToolCall || toolTimestamp > lastToolCall.timestamp)
        ) {
          lastToolCall = { name, timestamp: toolTimestamp };
        }

        const input = asRecord(state?.['input']);
        const command = asString(input?.['command']);
        if (!command || !isDeliverableCommand(command)) continue;
        const found = findDeliverables(state?.['output']);
        for (const number of found.prNumbers) prNumbers.add(number);
        for (const sha of found.commitShas) commitShas.add(sha);
      }
    }

    const model = asRecord(info['model']);
    const modelId = messageModelId ?? asString(model?.['id']);
    const providerId = messageProviderId ?? asString(model?.['providerID']);
    const title = asString(info['title']);
    const infoCost = asNumber(info['cost']);

    return [
      {
        sessionId,
        source: 'cli',
        agent: 'opencode',
        ...(asString(info['directory']) && {
          cwd: asString(info['directory']),
        }),
        ...(modelId && {
          model: providerId ? `${providerId}/${modelId}` : modelId,
        }),
        startedAt,
        lastActivityAt,
        turns,
        toolCallCounts,
        tokens:
          tokenUsage(info['tokens']) ??
          (measuredMessageTokens ? summedTokens : emptyTokens()),
        ...(lastToolCall && { lastToolCall }),
        ...(title && {
          title: truncateTitle(title),
          titleSource: 'generated' as const,
        }),
        deliverables: {
          prNumbers: Array.from(prNumbers),
          commitShas: Array.from(commitShas),
        },
        ...(infoCost !== undefined
          ? { totalCostUsd: infoCost }
          : measuredMessageCost
            ? { totalCostUsd: summedCost }
            : {}),
      },
    ];
  },
};
