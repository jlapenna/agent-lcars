import * as fs from 'fs';

/**
 * Bound applied to the extracted text, matching `toRunResult`'s own
 * 16,384-byte cap on the message the console ultimately renders
 * (`apps/console/src/lib/run-result.ts`) — there is no reason to carry more
 * than the console will ever keep.
 */
export const OPENCODE_LAST_MESSAGE_MAX_BYTES = 16_384;

function boundUtf8Bytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  return buffer.byteLength <= maxBytes
    ? text
    : buffer.subarray(0, maxBytes).toString('utf8');
}

function lastAssistantTextPart(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const messages = (parsed as Record<string, unknown>)['messages'];
  if (!Array.isArray(messages)) {
    return undefined;
  }

  let lastText: string | undefined;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const info = (message as Record<string, unknown>)['info'];
    const role =
      info && typeof info === 'object'
        ? (info as Record<string, unknown>)['role']
        : undefined;
    if (role !== 'assistant') continue;
    const parts = (message as Record<string, unknown>)['parts'];
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const record = part as Record<string, unknown>;
      if (record['type'] === 'text' && typeof record['text'] === 'string') {
        lastText = record['text'];
      }
    }
  }
  return lastText;
}

/**
 * Reads `exportPath` — an OpenCode raw (unsanitized) session export, the
 * sibling `captureOpenCodeExports` already writes beside its sanitized
 * JSONL for resumability (spec decision 3, plan 4) — and returns the last
 * assistant text part it contains: the exact closing turn of the
 * conversation. Verified against a real 1MB export with
 * `jq -r '[.messages[] | select(.info.role=="assistant") | .parts[]? |
 * select(.type=="text") | .text] | last'` (issue #1784); this is that same
 * query, hand-written because the sidecar has no `jq` dependency.
 *
 * The sanitized JSONL `captureOpenCodeExports` also materializes cannot
 * answer this: `--sanitize` replaces every word of the conversation with a
 * redaction marker (see `finalize.ts`'s `resumeGcsUri` comment), and this
 * module's own allowlist in `opencode-export-capture.ts` drops `text` parts
 * entirely. Only the raw export still carries real message text.
 *
 * Fails soft throughout, matching the rest of this capture path: a missing
 * or unreadable file, malformed JSON, a non-object export, a `messages`
 * field that is missing or not an array, or an export with no assistant
 * `text` part all return `undefined` rather than throwing. A missing final
 * message must never fail the run — the round still has a real outcome, it
 * just renders without a turn (the same fail-soft shape Claude's `--print`
 * and Codex's `--output-last-message` already have when their own capture
 * comes up empty).
 */
export function extractLastAssistantText(
  exportPath: string,
  readFile: (path: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): string | undefined {
  let contents: string;
  try {
    contents = readFile(exportPath);
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }

  const text = lastAssistantTextPart(parsed);
  return text === undefined
    ? undefined
    : boundUtf8Bytes(text, OPENCODE_LAST_MESSAGE_MAX_BYTES);
}
