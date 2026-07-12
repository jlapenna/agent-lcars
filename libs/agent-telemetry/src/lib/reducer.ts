import { findDeliverables } from './deliverables';
import { ReduceTranscriptOptions, SessionSummary, TokenUsage } from './types';
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
} from './unknown-value';

const ISSUE_AGENT_ENTRYPOINT = 'claude-code-github-action';
const TITLE_MAX_LENGTH = 80;

interface SessionState {
  sessionId: string;
  source: SessionSummary['source'];
  host?: string;
  cwd?: string;
  worktree?: string;
  branch?: string;
  model?: string;
  permissionMode?: string;
  startedAt?: string;
  lastActivityAt?: string;
  turns: number;
  toolCallCounts: Record<string, number>;
  tokens: TokenUsage;
  lastToolCall?: { name: string; timestamp: string };
  aiTitle?: string;
  firstUserPrompt?: string;
  prNumbers: Set<number>;
  commitShas: Set<string>;
}

function createState(sessionId: string, host?: string): SessionState {
  return {
    sessionId,
    source: 'cli',
    host,
    turns: 0,
    toolCallCounts: {},
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    prNumbers: new Set(),
    commitShas: new Set(),
  };
}

function applyTimestamp(state: SessionState, timestamp: string | undefined) {
  if (!timestamp) {
    return;
  }
  if (!state.startedAt || timestamp < state.startedAt) {
    state.startedAt = timestamp;
  }
  if (!state.lastActivityAt || timestamp > state.lastActivityAt) {
    state.lastActivityAt = timestamp;
  }
}

function truncateTitle(text: string, maxLength = TITLE_MAX_LENGTH): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength - 1)}…`
    : collapsed;
}

function applyMessage(
  state: SessionState,
  message: Record<string, unknown>,
  isSidechain: boolean,
  timestamp: string | undefined,
) {
  const role = asString(message['role']);
  const model = asString(message['model']);
  if (model) {
    state.model = model;
  }

  const content = asArray(message['content']) ?? [];

  if (role === 'user' && !isSidechain && !state.firstUserPrompt) {
    for (const block of content) {
      const record = asRecord(block);
      const text = record && asString(record['text']);
      if (record && asString(record['type']) === 'text' && text) {
        state.firstUserPrompt = text;
        break;
      }
    }
  }

  if (role === 'assistant') {
    if (!isSidechain) {
      state.turns += 1;
    }

    const usage = asRecord(message['usage']);
    if (usage) {
      state.tokens.inputTokens += asNumber(usage['input_tokens']) ?? 0;
      state.tokens.outputTokens += asNumber(usage['output_tokens']) ?? 0;
      state.tokens.cacheCreationTokens +=
        asNumber(usage['cache_creation_input_tokens']) ?? 0;
      state.tokens.cacheReadTokens +=
        asNumber(usage['cache_read_input_tokens']) ?? 0;
    }

    for (const block of content) {
      const record = asRecord(block);
      if (!record || asString(record['type']) !== 'tool_use') {
        continue;
      }
      const name = asString(record['name']);
      if (!name) {
        continue;
      }
      state.toolCallCounts[name] = (state.toolCallCounts[name] ?? 0) + 1;
      if (timestamp) {
        state.lastToolCall = { name, timestamp };
      }
    }
  }
}

function applyLine(state: SessionState, raw: Record<string, unknown>) {
  const timestamp = asString(raw['timestamp']);
  applyTimestamp(state, timestamp);

  const isSidechain = asBoolean(raw['isSidechain']) ?? false;

  const entrypoint = asString(raw['entrypoint']);
  if (entrypoint === ISSUE_AGENT_ENTRYPOINT) {
    state.source = 'issue-agent';
  }

  const cwd = asString(raw['cwd']);
  if (cwd) {
    state.cwd = cwd;
  }
  const relocatedCwd = asString(raw['relocatedCwd']);
  if (relocatedCwd) {
    state.cwd = relocatedCwd;
  }

  const gitBranch = asString(raw['gitBranch']);
  if (gitBranch) {
    state.branch = gitBranch;
  }

  const permissionMode = asString(raw['permissionMode']);
  if (permissionMode) {
    state.permissionMode = permissionMode;
  }

  const worktreeSession = asRecord(raw['worktreeSession']);
  const worktreePath =
    worktreeSession && asString(worktreeSession['worktreePath']);
  if (worktreePath) {
    state.worktree = worktreePath;
  }

  const aiTitle = asString(raw['aiTitle']);
  if (aiTitle) {
    state.aiTitle = aiTitle;
  }

  const message = asRecord(raw['message']);
  if (message) {
    applyMessage(state, message, isSidechain, timestamp);
  }

  const found = findDeliverables(raw);
  for (const prNumber of found.prNumbers) {
    state.prNumbers.add(prNumber);
  }
  for (const sha of found.commitShas) {
    state.commitShas.add(sha);
  }
}

function finalizeState(state: SessionState): SessionSummary {
  const title = resolveTitle(state);
  return {
    sessionId: state.sessionId,
    source: state.source,
    ...(state.host && { host: state.host }),
    ...(state.cwd && { cwd: state.cwd }),
    ...(state.worktree && { worktree: state.worktree }),
    ...(state.branch && { branch: state.branch }),
    ...(state.model && { model: state.model }),
    ...(state.permissionMode && { permissionMode: state.permissionMode }),
    startedAt: state.startedAt ?? '',
    lastActivityAt: state.lastActivityAt ?? '',
    turns: state.turns,
    toolCallCounts: state.toolCallCounts,
    tokens: state.tokens,
    ...(state.lastToolCall && { lastToolCall: state.lastToolCall }),
    ...(title && { title }),
    deliverables: {
      ...(state.branch && { branch: state.branch }),
      prNumbers: Array.from(state.prNumbers),
      commitShas: Array.from(state.commitShas),
    },
  };
}

function resolveTitle(state: SessionState): string | undefined {
  if (state.aiTitle) {
    return state.aiTitle;
  }
  return state.firstUserPrompt
    ? truncateTitle(state.firstUserPrompt)
    : undefined;
}

/**
 * Reduces one or more raw Claude Code transcript file contents (JSONL) into
 * a session summary per distinct `sessionId` found across all of them.
 * Pass multiple file contents, in chronological order, to correctly reduce
 * a resumed/compacted session that spans more than one file.
 *
 * Accepts any `Iterable<string>` (not just an array) so a caller with many
 * large files on disk can lazily yield one file's content at a time instead
 * of holding every file in memory simultaneously.
 */
export function reduceTranscripts(
  rawContents: Iterable<string>,
  options: ReduceTranscriptOptions = {},
): SessionSummary[] {
  const states = new Map<string, SessionState>();
  const seenUuids = new Set<string>();

  for (const content of rawContents) {
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const raw = asRecord(parsed);
      if (!raw) {
        continue;
      }

      const sessionId = asString(raw['sessionId']);
      if (!sessionId) {
        continue;
      }

      const uuid = asString(raw['uuid']);
      if (uuid) {
        if (seenUuids.has(uuid)) {
          continue;
        }
        seenUuids.add(uuid);
      }

      const state =
        states.get(sessionId) ?? createState(sessionId, options.host);
      applyLine(state, raw);
      states.set(sessionId, state);
    }
  }

  return Array.from(states.values()).map(finalizeState);
}

/** Convenience wrapper around {@link reduceTranscripts} for a single file. */
export function reduceTranscript(
  rawContent: string,
  options: ReduceTranscriptOptions = {},
): SessionSummary[] {
  return reduceTranscripts([rawContent], options);
}
