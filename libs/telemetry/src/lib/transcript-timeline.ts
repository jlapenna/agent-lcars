import { extractAntigravityUserRequest } from './antigravity-transcript-adapter';
import { SessionAgent } from './types';
import { asArray, asBoolean, asRecord, asString } from './unknown-value';

/**
 * Agents whose archived transcripts {@link parseTranscriptTimeline} actually
 * understands. OpenCode exports use a single JSON envelope of message info
 * and parts; Claude and Codex use JSONL. Codex's raw rollout JSONL uses a different line shape
 * (`session_meta`/`turn_context`/`event_msg` envelopes wrapping a `payload`
 * — see `codex-transcript-adapter.ts`) than Claude Code's
 * `message.role`/`message.content` shape, so each has an explicit parsing
 * branch below. `TRANSCRIPT_ADAPTERS` answers "can we summarize this?";
 * this list separately answers "can we render it as a timeline?". Conflating
 * those capabilities was
 * exactly Bug 3 in agent-lcars#645 (the console gated timeline rendering on
 * a literal `=== 'claude-code'` check that happened to match this list's
 * current contents by coincidence, not by reading it).
 *
 * `isRenderableTranscriptAgent` is this list's read side, and
 * `session-doc.ts`'s `buildSessionDoc` is its one write side — see that
 * function's `renderable` field. Extend this list only alongside a genuine
 * parsing branch for the new format below, backed by real fixtures of that
 * agent's raw lines (see `transcript-timeline.spec.ts`) — never just to flip
 * the flag on and hope the existing Claude-Code-shaped parsing happens to
 * produce something plausible for a format it was never written to read.
 */
export const RENDERABLE_TRANSCRIPT_AGENTS: readonly SessionAgent[] = [
  'claude-code',
  'codex',
  'opencode',
  'antigravity',
];

/** Whether {@link parseTranscriptTimeline} can render this agent's raw
 * transcript lines as a timeline — see {@link RENDERABLE_TRANSCRIPT_AGENTS}. */
export function isRenderableTranscriptAgent(agent: SessionAgent): boolean {
  return RENDERABLE_TRANSCRIPT_AGENTS.includes(agent);
}

export interface TranscriptTextEvent {
  kind: 'text';
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

export interface TranscriptToolUseEvent {
  kind: 'tool_use';
  name: string;
  /** JSON-stringified input in full - never the live object. The rendering
   * layer collapses long blocks; it never receives a cut copy. */
  inputJson: string;
  timestamp?: string;
}

export interface TranscriptToolResultEvent {
  kind: 'tool_result';
  /** Stringified content in full - tool_result content can be a plain
   * string or a content-block array; both are flattened to text here. */
  content: string;
  timestamp?: string;
}

export interface TranscriptResultEvent {
  kind: 'result';
  subtype: string;
  isError: boolean;
  timestamp?: string;
}

/** A contiguous run of `isSidechain: true` lines (one Task subagent's
 * activity), collapsed into a single timeline entry rather than interleaved
 * event-by-event with the main chain. */
export interface TranscriptSidechainGroupEvent {
  kind: 'sidechain-group';
  events: TranscriptTimelineEvent[];
  /** Set on a paginated page's leading sidechain group when the preceding page
   * ended mid-sidechain under the carry-state fallback, signaling the incremental
   * viewer to merge `events` into the previous page's trailing sidechain group. */
  continuesPrevious?: boolean;
}

export type TranscriptTimelineEvent =
  | TranscriptTextEvent
  | TranscriptToolUseEvent
  | TranscriptToolResultEvent
  | TranscriptResultEvent
  | TranscriptSidechainGroupEvent;

export interface ParsedTranscriptTimeline {
  events: TranscriptTimelineEvent[];
  /** True when at least one line was malformed JSON or an unrecognized
   * shape and was skipped - surfaced as a soft warning by the caller, never
   * thrown (matches reducer.ts's tolerance). */
  hadUnparseableLines: boolean;
}

/** Bounded `O(1)` parser state carried in pagination cursors across byte-range
 * page boundaries when a turn or subagent sidechain spans a full page window. */
export interface TranscriptPageParseState {
  inSidechain?: boolean;
  pendingCodexTurnHash?: string;
}

export interface ParseTranscriptTimelineChunkOptions {
  startOffset: number;
  eof: boolean;
  agent?: SessionAgent;
  initialState?: TranscriptPageParseState;
}

export interface ParsedTranscriptTimelineChunk extends ParsedTranscriptTimeline {
  nextOffset: number;
  nextState: TranscriptPageParseState;
}

/**
 * Pure ECMAScript dual-lane fingerprint (`role + length + 2x53-bit cyrb53`)
 * so `@agent-lcars/telemetry` stays browser-safe (`platform:shared`) while
 * keeping Codex cross-page turn deduplication compact (`O(1)` cursor size).
 */
export function hashCodexTextTurn(
  role: 'user' | 'assistant',
  text: string,
): string {
  let h1 = role === 'user' ? 0xdeadbeef : 0xabcdef01;
  let h2 = role === 'user' ? 0x41c6ce57 : 0x1b873593;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hi = (h2 >>> 0).toString(36);
  const lo = (h1 >>> 0).toString(36);
  return `${role[0]}:${text.length.toString(36)}:${hi}:${lo}`;
}

function contentToText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  const blocks = asArray(content);
  if (!blocks) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (!record) continue;
    const text = asString(record['text']) ?? asString(record['content']);
    if (text) {
      parts.push(text);
    } else {
      // A nested tool_result content block, or anything else unrecognized -
      // still surface something rather than silently dropping it.
      parts.push(JSON.stringify(record));
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * Converts one parsed transcript line's `message.content` blocks into
 * timeline events. `role` disambiguates a `tool_result` (always carried in a
 * `user`-role message in Claude Code transcripts) from a genuine user text
 * turn.
 */
function eventsFromMessage(
  message: Record<string, unknown>,
  timestamp: string | undefined,
): TranscriptTimelineEvent[] {
  const role = asString(message['role']);
  const content = asArray(message['content']);
  if (!content) {
    return [];
  }

  const events: TranscriptTimelineEvent[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record) continue;
    const type = asString(record['type']);

    if (type === 'text') {
      const text = asString(record['text']);
      if (text && (role === 'user' || role === 'assistant')) {
        events.push({ kind: 'text', role, text, timestamp });
      }
      continue;
    }

    if (type === 'tool_use') {
      const name = asString(record['name']);
      if (name) {
        events.push({
          kind: 'tool_use',
          name,
          inputJson: JSON.stringify(record['input'] ?? {}, null, 2),
          timestamp,
        });
      }
      continue;
    }

    if (type === 'tool_result') {
      const text = contentToText(record['content']);
      events.push({
        kind: 'tool_result',
        content: text ?? JSON.stringify(record),
        timestamp,
      });
      continue;
    }
    // Unrecognized content block type - skipped, not fatal (see
    // hadUnparseableLines for the line-level equivalent).
  }
  return events;
}

function codexTextEvent(
  role: 'user' | 'assistant',
  text: unknown,
  timestamp: string | undefined,
): TranscriptTextEvent[] {
  const value = asString(text);
  return value ? [{ kind: 'text', role, text: value, timestamp }] : [];
}

/** Converts a Codex rollout envelope into zero or more shared timeline events. */
function eventsFromCodexLine(
  raw: Record<string, unknown>,
  timestamp: string | undefined,
): TranscriptTimelineEvent[] {
  const lineType = asString(raw['type']);
  const payload = asRecord(raw['payload']);
  if (!payload) return [];

  const payloadType = asString(payload['type']);
  if (lineType === 'event_msg') {
    if (payloadType === 'user_message') {
      return codexTextEvent('user', payload['message'], timestamp);
    }
    if (payloadType === 'agent_message') {
      return codexTextEvent('assistant', payload['message'], timestamp);
    }
    if (payloadType === 'task_complete') {
      return [
        { kind: 'result', subtype: 'success', isError: false, timestamp },
      ];
    }
    if (payloadType === 'turn_aborted') {
      return [
        { kind: 'result', subtype: 'turn_aborted', isError: true, timestamp },
      ];
    }
    return [];
  }

  if (lineType !== 'response_item') return [];

  if (payloadType === 'message') {
    const role = asString(payload['role']);
    if (role !== 'user' && role !== 'assistant') return [];
    const events: TranscriptTimelineEvent[] = [];
    for (const block of asArray(payload['content']) ?? []) {
      const record = asRecord(block);
      if (!record) continue;
      const text = asString(record['text']);
      if (text) events.push(...codexTextEvent(role, text, timestamp));
    }
    return events;
  }

  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    const name = asString(payload['name']);
    if (!name) return [];
    const input = payload['arguments'] ?? payload['input'] ?? {};
    const inputJson =
      typeof input === 'string' ? input : JSON.stringify(input, null, 2);
    return [{ kind: 'tool_use', name, inputJson, timestamp }];
  }

  if (
    payloadType === 'function_call_output' ||
    payloadType === 'custom_tool_call_output'
  ) {
    const output = contentToText(payload['output']);
    return [
      {
        kind: 'tool_result',
        content: output ?? JSON.stringify(payload['output'] ?? ''),
        timestamp,
      },
    ];
  }

  return [];
}

/** Converts an Antigravity step line into zero or more shared timeline events. */
function eventsFromAntigravityLine(
  raw: Record<string, unknown>,
  timestamp: string | undefined,
): TranscriptTimelineEvent[] {
  const source = asString(raw['source']);
  const stepType = asString(raw['type']);
  const content = asString(raw['content']);

  if (stepType === 'USER_INPUT' && source === 'USER_EXPLICIT') {
    if (!content) return [];
    const body = extractAntigravityUserRequest(content);
    if (!body) return [];
    return [{ kind: 'text', role: 'user', text: body, timestamp }];
  }

  if (stepType === 'PLANNER_RESPONSE') {
    const events: TranscriptTimelineEvent[] = [];
    if (content && content.trim()) {
      events.push({
        kind: 'text',
        role: 'assistant',
        text: content,
        timestamp,
      });
    }
    for (const tc of asArray(raw['tool_calls']) ?? []) {
      const record = asRecord(tc);
      const name = asString(record?.['name']);
      if (!name) continue;
      const args = record?.['args'] ?? {};
      const inputJson =
        typeof args === 'string' ? args : JSON.stringify(args, null, 2);
      events.push({
        kind: 'tool_use',
        name,
        inputJson,
        timestamp,
      });
    }
    return events;
  }

  if (stepType === 'GENERIC' && source === 'MODEL') {
    if (!content) return [];
    return [
      {
        kind: 'tool_result',
        content,
        timestamp,
      },
    ];
  }

  return [];
}

/** OpenCode exports are one JSON envelope, even when pretty-printed. The
 * telemetry archive uses the same envelope with conversation fields removed. */
function parseOpenCodeTimeline(rawContent: string): ParsedTranscriptTimeline {
  const events: TranscriptTimelineEvent[] = [];
  let hadUnparseableLines = false;
  let raw: Record<string, unknown> | undefined;
  try {
    raw = asRecord(JSON.parse(rawContent));
  } catch {
    return { events, hadUnparseableLines: true };
  }
  const info = asRecord(raw?.['info']);
  const messages = asArray(raw?.['messages']);
  if (!asString(info?.['id']) || !messages) {
    return { events, hadUnparseableLines: true };
  }
  const isoTime = (value: unknown): string | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  };
  for (const value of messages) {
    const message = asRecord(value);
    const messageInfo = asRecord(message?.['info']);
    const role = asString(messageInfo?.['role']);
    const parts = asArray(message?.['parts']);
    if ((role !== 'user' && role !== 'assistant') || !parts) {
      hadUnparseableLines = true;
      continue;
    }
    const timestamp = isoTime(asRecord(messageInfo?.['time'])?.['created']);
    if (parts.length === 0) {
      events.push({
        kind: 'text',
        role,
        text: '[Archived turn: content redacted or absent]',
        timestamp,
      });
    }
    for (const value of parts) {
      const part = asRecord(value);
      if (!part || typeof part['type'] !== 'string') {
        hadUnparseableLines = true;
        continue;
      }
      if (part['type'] === 'text') {
        const text = asString(part['text']);
        if (text === undefined) hadUnparseableLines = true;
        else if (text) events.push({ kind: 'text', role, text, timestamp });
      } else if (part['type'] === 'tool') {
        const name = asString(part['tool']);
        // The metadata archive owner omits state when no timestamps exist,
        // including pending tools. Keep those redacted events renderable.
        const state =
          part['state'] === undefined ? {} : asRecord(part['state']);
        if (!name || !state) {
          hadUnparseableLines = true;
          continue;
        }
        const time = asRecord(state['time']);
        events.push({
          kind: 'tool_use',
          name,
          inputJson:
            state['input'] === undefined
              ? '[Tool input redacted or absent]'
              : JSON.stringify(state['input'], null, 2),
          timestamp: isoTime(time?.['start']) ?? timestamp,
        });
        if (state['status'] === 'completed' || state['status'] === 'error') {
          events.push({
            kind: 'tool_result',
            content:
              asString(state['error']) ??
              asString(state['output']) ??
              '[Tool output redacted or absent]',
            timestamp: isoTime(time?.['end']) ?? timestamp,
          });
        }
      }
      // Reasoning, step accounting, files and snapshots are not conversation
      // turns. Never stringify their arbitrary metadata into the console.
    }
  }
  return { events, hadUnparseableLines };
}

function updatePendingToolResults(
  current: number,
  emitted: readonly TranscriptTimelineEvent[],
): number {
  if (emitted.length === 0) return current;
  let toolUses = 0;
  let toolResults = 0;
  for (const event of emitted) {
    if (event.kind === 'tool_use') toolUses += 1;
    else if (event.kind === 'tool_result') toolResults += 1;
  }
  if (toolUses > 0) {
    return toolUses;
  }
  if (toolResults > 0) {
    return Math.max(0, current - toolResults);
  }
  // A plain user/assistant text turn or terminal result with no tool blocks
  // closes any interrupted tool call that never produced a tool_result.
  return 0;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const utf8Encoder = new TextEncoder();

/**
 * Parses a raw UTF-8 JSONL byte chunk from `[startOffset, ...)` with smart
 * page-boundary snapping and `O(1)` cross-page state fallback:
 *
 * 1. When `!eof`, slices at the last `\n` (`0x0a`) so partial UTF-8 sequences
 *    and incomplete trailing JSONL lines are never parsed.
 * 2. When `!eof` and the chunk ends mid-sidechain, right after a `tool_use`
 *    awaiting its `tool_result`, or right after a Codex `event_msg` awaiting
 *    its duplicate `response_item`, snaps `nextOffset` back to the latest
 *    earlier safe cut point in the chunk that already produced `>= 1` event.
 * 3. When a single giant sidechain or turn spans the entire chunk so snapping
 *    back would produce zero events, advances `nextOffset` to `lastNewline + 1`
 *    and carries `inSidechain` / `pendingCodexTurnHash` in `nextState`.
 */
export function parseTranscriptTimelineChunk(
  chunk: Uint8Array,
  options: ParseTranscriptTimelineChunkOptions,
): ParsedTranscriptTimelineChunk {
  const { startOffset, eof, agent = 'claude-code', initialState } = options;

  if (agent === 'opencode') {
    const decoded = utf8Decoder.decode(chunk);
    const parsed = parseOpenCodeTimeline(decoded);
    return {
      ...parsed,
      nextOffset: startOffset + chunk.length,
      nextState: {},
    };
  }

  if (chunk.length === 0) {
    return {
      events: [],
      hadUnparseableLines: false,
      nextOffset: startOffset,
      nextState: initialState ? { ...initialState } : {},
    };
  }

  let usable = chunk;
  if (!eof) {
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      return {
        events: [],
        hadUnparseableLines: false,
        nextOffset: startOffset,
        nextState: initialState ? { ...initialState } : {},
      };
    }
    usable = chunk.subarray(0, lastNewline + 1);
  }

  const events: TranscriptTimelineEvent[] = [];
  let currentSidechain: TranscriptTimelineEvent[] | undefined =
    agent === 'claude-code' && initialState?.inSidechain ? [] : undefined;
  let sidechainContinuesPrevious = Boolean(
    agent === 'claude-code' && initialState?.inSidechain,
  );
  let hadUnparseableLines = false;
  let lastCodexTurnHash =
    agent === 'codex' ? initialState?.pendingCodexTurnHash : undefined;
  let pendingToolResults = 0;
  let awaitingCodexDuplicate = false;

  interface SafeCutSnapshot {
    nextOffset: number;
    eventsCount: number;
    hadUnparseableLines: boolean;
    pendingCodexTurnHash?: string;
  }
  let lastSafeCut: SafeCutSnapshot | undefined;

  const closeSidechain = () => {
    if (currentSidechain && currentSidechain.length > 0) {
      events.push({
        kind: 'sidechain-group',
        events: currentSidechain,
        ...(sidechainContinuesPrevious && { continuesPrevious: true }),
      });
    }
    currentSidechain = undefined;
    sidechainContinuesPrevious = false;
  };

  let lineStart = 0;
  while (lineStart < usable.length) {
    const nl = usable.indexOf(0x0a, lineStart);
    const lineEnd = nl === -1 ? usable.length : nl;
    const nextByteOffset =
      nl === -1 ? startOffset + usable.length : startOffset + nl + 1;
    const line = utf8Decoder.decode(usable.subarray(lineStart, lineEnd));
    lineStart = nl === -1 ? usable.length : nl + 1;

    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      hadUnparseableLines = true;
      continue;
    }

    const raw = asRecord(parsed);
    if (!raw) {
      hadUnparseableLines = true;
      continue;
    }

    const timestamp = asString(raw['timestamp']) ?? asString(raw['created_at']);
    if (agent === 'antigravity') {
      const lineEvents = eventsFromAntigravityLine(raw, timestamp);
      events.push(...lineEvents);
      pendingToolResults = updatePendingToolResults(
        pendingToolResults,
        lineEvents,
      );
    } else if (agent === 'codex') {
      const lineType = asString(raw['type']);
      const payloadType = asString(asRecord(raw['payload'])?.['type']);
      const lineEvents = eventsFromCodexLine(raw, timestamp);
      const acceptedLineEvents: TranscriptTimelineEvent[] = [];
      for (const event of lineEvents) {
        if (event.kind === 'text') {
          const turnHash = hashCodexTextTurn(event.role, event.text);
          // Codex currently persists a message as both an event_msg and a
          // response_item. They are adjacent once metadata-only envelopes are
          // ignored; render the turn once while still accepting either shape.
          if (turnHash === lastCodexTurnHash) {
            continue;
          }
          lastCodexTurnHash = turnHash;
          acceptedLineEvents.push(event);
          events.push(event);
        } else {
          lastCodexTurnHash = undefined;
          acceptedLineEvents.push(event);
          events.push(event);
        }
      }
      pendingToolResults = updatePendingToolResults(
        pendingToolResults,
        acceptedLineEvents,
      );
      if (
        lineType === 'event_msg' &&
        (payloadType === 'user_message' || payloadType === 'agent_message') &&
        lineEvents.length > 0
      ) {
        awaitingCodexDuplicate = true;
      } else if (
        (lineType === 'response_item' && payloadType === 'message') ||
        acceptedLineEvents.length > 0
      ) {
        awaitingCodexDuplicate = false;
      }
    } else {
      const isSidechain = asBoolean(raw['isSidechain']) ?? false;
      const target = isSidechain ? (currentSidechain ??= []) : events;

      if (!isSidechain) {
        closeSidechain();
      }

      const emittedTopLevel: TranscriptTimelineEvent[] = [];
      if (asString(raw['type']) === 'result') {
        const subtype = asString(raw['subtype']);
        const isError = asBoolean(raw['is_error']);
        if (subtype !== undefined && isError !== undefined) {
          const resultEvent: TranscriptResultEvent = {
            kind: 'result',
            subtype,
            isError,
            timestamp,
          };
          target.push(resultEvent);
          if (!isSidechain) emittedTopLevel.push(resultEvent);
        }
      } else {
        const message = asRecord(raw['message']);
        if (message) {
          const messageEvents = eventsFromMessage(message, timestamp);
          target.push(...messageEvents);
          if (!isSidechain) emittedTopLevel.push(...messageEvents);
        }
      }

      if (!isSidechain) {
        pendingToolResults = updatePendingToolResults(
          pendingToolResults,
          emittedTopLevel,
        );
      }
    }

    if (
      currentSidechain === undefined &&
      pendingToolResults === 0 &&
      !awaitingCodexDuplicate &&
      events.length > 0
    ) {
      lastSafeCut = {
        nextOffset: nextByteOffset,
        eventsCount: events.length,
        hadUnparseableLines,
        ...(agent === 'codex' &&
          lastCodexTurnHash && { pendingCodexTurnHash: lastCodexTurnHash }),
      };
    }
  }

  if (eof) {
    closeSidechain();
    return {
      events,
      hadUnparseableLines,
      nextOffset: startOffset + usable.length,
      nextState: {},
    };
  }

  const endIsSafe =
    currentSidechain === undefined &&
    pendingToolResults === 0 &&
    !awaitingCodexDuplicate;

  if (!endIsSafe && lastSafeCut && lastSafeCut.nextOffset > startOffset) {
    events.length = lastSafeCut.eventsCount;
    return {
      events,
      hadUnparseableLines: lastSafeCut.hadUnparseableLines,
      nextOffset: lastSafeCut.nextOffset,
      nextState: lastSafeCut.pendingCodexTurnHash
        ? { pendingCodexTurnHash: lastSafeCut.pendingCodexTurnHash }
        : {},
    };
  }

  const stillInSidechain = currentSidechain !== undefined;
  closeSidechain();
  return {
    events,
    hadUnparseableLines,
    nextOffset: startOffset + usable.length,
    nextState: {
      ...(stillInSidechain && { inSidechain: true }),
      ...(agent === 'codex' &&
        lastCodexTurnHash && { pendingCodexTurnHash: lastCodexTurnHash }),
    },
  };
}

/**
 * Merges a newly fetched transcript page into the already-loaded timeline,
 * folding a leading `{ kind: 'sidechain-group', continuesPrevious: true }`
 * into the previous page's trailing `sidechain-group` so subagent runs that
 * span multiple pages remain a single disclosure block.
 */
export function mergeTranscriptTimelinePages(
  existing: readonly (TranscriptTimelineEvent | TranscriptElisionDivider)[],
  incoming: readonly TranscriptTimelineEvent[],
): (TranscriptTimelineEvent | TranscriptElisionDivider)[] {
  if (incoming.length === 0) {
    return [...existing];
  }
  const merged = [...existing];
  let startIndex = 0;
  const first = incoming[0];
  const lastExisting = merged.at(-1);
  if (
    first?.kind === 'sidechain-group' &&
    first.continuesPrevious &&
    lastExisting?.kind === 'sidechain-group'
  ) {
    merged[merged.length - 1] = {
      kind: 'sidechain-group',
      events: [...lastExisting.events, ...first.events],
      ...(lastExisting.continuesPrevious && { continuesPrevious: true }),
    };
    startIndex = 1;
  } else if (first?.kind === 'sidechain-group' && first.continuesPrevious) {
    // Strip the transport marker if no trailing sidechain-group preceded it
    // (e.g. when the previous page's sidechain lines produced 0 events).
    merged.push({ kind: 'sidechain-group', events: first.events });
    startIndex = 1;
  }
  for (let i = startIndex; i < incoming.length; i += 1) {
    merged.push(incoming[i]);
  }
  return merged;
}

/**
 * Parses an archived transcript from a supported agent into a
 * flat, renderable timeline for a single session's detail page - a
 * different shape than `reduceTranscripts`' aggregated `SessionSummary`, but
 * deliberately reusing the same tolerant line-by-line approach and
 * `unknown-value.ts` helpers rather than a second bespoke JSON-walking loop:
 * unparseable JSON and unrecognized line shapes are skipped, never thrown.
 *
 * Sidechain (subagent) lines are collapsed: a contiguous run of
 * `isSidechain: true` lines becomes one `sidechain-group` timeline entry
 * instead of being interleaved with the main chain event-by-event - see
 * `TranscriptSidechainGroupEvent`.
 */
export function parseTranscriptTimeline(
  rawContent: string,
  agent: SessionAgent = 'claude-code',
): ParsedTranscriptTimeline {
  if (agent === 'opencode') return parseOpenCodeTimeline(rawContent);
  const { events, hadUnparseableLines } = parseTranscriptTimelineChunk(
    utf8Encoder.encode(rawContent),
    { startOffset: 0, eof: true, agent },
  );
  return { events, hadUnparseableLines };
}

/** A run of middle events the page renders collapsed behind an expander.
 * It carries every event it stands for; nothing is dropped. */
export interface TranscriptElisionDivider {
  kind: 'elision';
  elidedCount: number;
  events: TranscriptTimelineEvent[];
}

/** Above this many top-level rendered events, the middle is collapsed. */
const ELISION_THRESHOLD = 400;
const ELISION_HEAD = 50;
const ELISION_TAIL = 200;

/**
 * Collapses the middle of a very long transcript (a busy issue-agent run can
 * span thousands of turns): the first {@link ELISION_HEAD} events (the
 * initial prompt/plan) and the last {@link ELISION_TAIL} (the outcome) stay
 * expanded and the rest move into one collapsed group the reader can open.
 * The full transcript is still in the page; only its initial display folds.
 */
export function elideTranscriptTimeline(
  events: TranscriptTimelineEvent[],
): (TranscriptTimelineEvent | TranscriptElisionDivider)[] {
  if (events.length <= ELISION_THRESHOLD) {
    return events;
  }
  const head = events.slice(0, ELISION_HEAD);
  const middle = events.slice(ELISION_HEAD, events.length - ELISION_TAIL);
  const tail = events.slice(events.length - ELISION_TAIL);
  return [
    ...head,
    { kind: 'elision', elidedCount: middle.length, events: middle },
    ...tail,
  ];
}

/** Type guard used by the rendering layer to distinguish an elision divider
 * from a real timeline event without a discriminated-union switch everywhere. */
export function isElisionDivider(
  entry: TranscriptTimelineEvent | TranscriptElisionDivider,
): entry is TranscriptElisionDivider {
  return entry.kind === 'elision';
}
