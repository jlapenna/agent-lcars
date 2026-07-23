import { findDeliverables } from './deliverables';
import {
  ReduceTranscriptOptions,
  SessionResult,
  SessionSummary,
  TokenUsage,
} from './types';
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
  seenAssistantMessageIds: Set<string>;
  toolCallCounts: Record<string, number>;
  tokens: TokenUsage;
  lastToolCall?: { name: string; timestamp: string };
  aiTitle?: string;
  firstUserPrompt?: string;
  prNumbers: Set<number>;
  commitShas: Set<string>;
  totalCostUsd?: number;
  result?: SessionResult;
}

function createState(sessionId: string, host?: string): SessionState {
  return {
    sessionId,
    source: 'cli',
    host,
    turns: 0,
    seenAssistantMessageIds: new Set(),
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
    // Claude Code emits one row per streamed content block (thinking, text,
    // each tool use), but every row for the same API response repeats the
    // response's full usage object and message id. Count the response once;
    // tool blocks below still remain independently discoverable.
    const messageId = asString(message['id']);
    const isNewAssistantMessage =
      !messageId || !state.seenAssistantMessageIds.has(messageId);
    if (messageId) {
      state.seenAssistantMessageIds.add(messageId);
    }

    if (!isSidechain && isNewAssistantMessage) {
      state.turns += 1;
    }

    const usage = asRecord(message['usage']);
    if (usage && isNewAssistantMessage) {
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

  // Per-turn cost, when the transcript line carries it (sibling of
  // `message`/`usage`, not inside them) — accumulated the same way Claude
  // Code's own cumulative session-cost tracking works, so it reads as a
  // running total during a still-live session, not just at the end.
  const costUsd = asNumber(raw['costUSD']);
  if (costUsd !== undefined) {
    state.totalCostUsd = (state.totalCostUsd ?? 0) + costUsd;
  }

  // Terminal result line (headless `-p`/stream-json runs only — see
  // SessionResult's doc comment in types.ts). Only one is expected per
  // session; a later one (shouldn't happen) simply wins.
  if (asString(raw['type']) === 'result') {
    const subtype = asString(raw['subtype']);
    const isError = asBoolean(raw['is_error']);
    if (subtype !== undefined && isError !== undefined) {
      state.result = { subtype, isError };
    }
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
    // This reducer only ever parses Claude Code's own transcript format
    // (see reduceTranscript(s)'s doc comment below), so every summary it
    // produces is unconditionally 'claude-code' — never inferred from the
    // transcript content itself. Other agents get their own adapter/reducer
    // (see transcript-adapter.ts) that stamps their own identity instead.
    agent: 'claude-code',
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
    ...(state.totalCostUsd !== undefined && {
      totalCostUsd: state.totalCostUsd,
    }),
    ...(state.result && { result: state.result }),
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
 * Core line-by-line reduction shared by every entry point below. Operates on
 * already-split lines (any `Iterable<string>`) specifically so a caller that
 * already has a line array in hand — {@link reduceTranscriptLines}'s callers,
 * namely `claudeCodeAdapter.reduce` in transcript-adapter.ts — never pays for
 * a join-then-resplit round trip through a string-based API. That round trip
 * was cheap enough to miss in small unit tests but measurably slow (~5x) on
 * a per-file basis against a large (2MB+) real transcript — see
 * daemon.memory.spec.ts, which times a full multi-hundred-MB corpus tick.
 */
function reduceLines(
  lines: Iterable<string>,
  options: ReduceTranscriptOptions = {},
): SessionSummary[] {
  const states = new Map<string, SessionState>();
  const seenUuids = new Set<string>();

  for (const line of lines) {
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

    const state = states.get(sessionId) ?? createState(sessionId, options.host);
    applyLine(state, raw);
    states.set(sessionId, state);
  }

  return Array.from(states.values()).map(finalizeState);
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
  function* linesFromContents() {
    for (const content of rawContents) {
      yield* content.split('\n');
    }
  }
  return reduceLines(linesFromContents(), options);
}

/**
 * Reduces a single file's already-split lines directly — the array a caller
 * gets from `content.split('\n')` (or, for `TranscriptAdapter.reduce`
 * implementations, the `lines` parameter itself) — without the join+resplit
 * {@link reduceTranscript}'s string-based API would otherwise force. See
 * {@link reduceLines}'s doc comment for why this exists as its own entry
 * point rather than just being an implementation detail.
 */
export function reduceTranscriptLines(
  lines: string[],
  options: ReduceTranscriptOptions = {},
): SessionSummary[] {
  return reduceLines(lines, options);
}

/** Convenience wrapper around {@link reduceTranscripts} for a single file. */
export function reduceTranscript(
  rawContent: string,
  options: ReduceTranscriptOptions = {},
): SessionSummary[] {
  return reduceTranscripts([rawContent], options);
}
