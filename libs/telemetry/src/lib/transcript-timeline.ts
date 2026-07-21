import { asArray, asBoolean, asRecord, asString } from './unknown-value';

/** ~2KB - roomy enough to read a real tool call/result at a glance, small
 * enough that one enormous Bash output or file read can't blow up the page. */
const MAX_BLOCK_CHARS = 2000;

function truncate(text: string, max = MAX_BLOCK_CHARS): string {
  if (text.length <= max) {
    return text;
  }
  const omitted = text.length - max;
  return `${text.slice(0, max)}\n… truncated (${omitted} more characters)`;
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
  /** JSON-stringified input, truncated - never the live object, so a
   * rendering layer never needs its own truncation logic. */
  inputJson: string;
  timestamp?: string;
}

export interface TranscriptToolResultEvent {
  kind: 'tool_result';
  /** Stringified content, truncated - tool_result content can be a plain
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
        events.push({ kind: 'text', role, text: truncate(text), timestamp });
      }
      continue;
    }

    if (type === 'tool_use') {
      const name = asString(record['name']);
      if (name) {
        events.push({
          kind: 'tool_use',
          name,
          inputJson: truncate(JSON.stringify(record['input'] ?? {}, null, 2)),
          timestamp,
        });
      }
      continue;
    }

    if (type === 'tool_result') {
      const text = contentToText(record['content']);
      events.push({
        kind: 'tool_result',
        content: truncate(text ?? JSON.stringify(record)),
        timestamp,
      });
      continue;
    }
    // Unrecognized content block type - skipped, not fatal (see
    // hadUnparseableLines for the line-level equivalent).
  }
  return events;
}

/**
 * Parses one or more raw Claude Code transcript file contents (JSONL) into a
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
): ParsedTranscriptTimeline {
  const events: TranscriptTimelineEvent[] = [];
  let currentSidechain: TranscriptTimelineEvent[] | undefined;
  let hadUnparseableLines = false;

  const closeSidechain = () => {
    if (currentSidechain && currentSidechain.length > 0) {
      events.push({ kind: 'sidechain-group', events: currentSidechain });
    }
    currentSidechain = undefined;
  };

  for (const line of rawContent.split('\n')) {
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

    const timestamp = asString(raw['timestamp']);
    const isSidechain = asBoolean(raw['isSidechain']) ?? false;
    const target = isSidechain ? (currentSidechain ??= []) : events;

    if (!isSidechain) {
      closeSidechain();
    }

    if (asString(raw['type']) === 'result') {
      const subtype = asString(raw['subtype']);
      const isError = asBoolean(raw['is_error']);
      if (subtype !== undefined && isError !== undefined) {
        target.push({ kind: 'result', subtype, isError, timestamp });
      }
      continue;
    }

    const message = asRecord(raw['message']);
    if (message) {
      target.push(...eventsFromMessage(message, timestamp));
      continue;
    }
    // Lines with neither a `message` nor a terminal `result` (queue
    // operations, ai-title, unknown future line types) carry no renderable
    // turn content - not an error, just nothing to add to the timeline.
  }

  closeSidechain();

  return { events, hadUnparseableLines };
}

export interface TranscriptElisionDivider {
  kind: 'elision';
  elidedCount: number;
}

/** Above this many top-level rendered events, the middle is elided. */
const ELISION_THRESHOLD = 400;
const ELISION_HEAD = 50;
const ELISION_TAIL = 200;

/**
 * Server-side elision for very long transcripts (a busy issue-agent run can
 * span thousands of turns): keeps the first {@link ELISION_HEAD} events (the
 * initial prompt/plan) and the last {@link ELISION_TAIL} (the outcome), with
 * a divider in between rather than truncating outright. No client-side
 * pagination in v1 - this is a read-only archive page, not a live feed, so
 * a single server-rendered page is simpler and sufficient; revisit only if
 * elided transcripts turn out to be a common need for the middle section.
 */
export function elideTranscriptTimeline(
  events: TranscriptTimelineEvent[],
): (TranscriptTimelineEvent | TranscriptElisionDivider)[] {
  if (events.length <= ELISION_THRESHOLD) {
    return events;
  }
  const head = events.slice(0, ELISION_HEAD);
  const tail = events.slice(events.length - ELISION_TAIL);
  const elidedCount = events.length - ELISION_HEAD - ELISION_TAIL;
  return [...head, { kind: 'elision', elidedCount }, ...tail];
}

/** Type guard used by the rendering layer to distinguish an elision divider
 * from a real timeline event without a discriminated-union switch everywhere. */
export function isElisionDivider(
  entry: TranscriptTimelineEvent | TranscriptElisionDivider,
): entry is TranscriptElisionDivider {
  return entry.kind === 'elision';
}
