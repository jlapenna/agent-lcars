import { createHash } from 'node:crypto';

import {
  RUN_MESSAGE_MAX_BYTES,
  RUN_MESSAGE_PREVIEW_MAX,
} from '@agent-lcars/dispatch-contracts';

import type { Run, RunMessageOverflow, RunResult } from './model';
import type { OrchestratorStore } from './store';

/** UTF-8 bytes per out-of-line chunk document: half of Firestore's 1 MiB
 * document limit, leaving ample room for the id and field overhead. */
export const RUN_MESSAGE_CHUNK_BYTES = 512 * 1024;

export interface SplitRunMessage {
  /** At most `RUN_MESSAGE_PREVIEW_MAX` characters, kept inline. */
  preview: string;
  /** Present only when the message does not fit inline. */
  overflow?: { ref: RunMessageOverflow; chunks: string[] };
}

/** Characters of a preview's tail. A park's blocker line and a PR summary
 * live at the end of a message, so the preview keeps both ends. */
export const RUN_MESSAGE_PREVIEW_TAIL = 4_096;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** At most `RUN_MESSAGE_PREVIEW_MAX` units: the head, an omission marker and
 * the tail, never splitting a surrogate pair. */
function previewOf(text: string): string {
  const marker = (omitted: number) =>
    `\n\n[… ${omitted} characters omitted from this preview; the whole message is stored with the run …]\n\n`;
  let tailStart = text.length - RUN_MESSAGE_PREVIEW_TAIL;
  if (isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1;
  // Size the marker for the largest omission; the real one is never longer.
  let headEnd =
    RUN_MESSAGE_PREVIEW_MAX -
    (text.length - tailStart) -
    marker(text.length).length;
  if (isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd -= 1;
  return (
    text.slice(0, headEnd) + marker(tailStart - headEnd) + text.slice(tailStart)
  );
}

/** Split UTF-8 bytes at code-point boundaries into chunks of at most
 * `RUN_MESSAGE_CHUNK_BYTES`. */
function chunksOf(bytes: Buffer): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < bytes.byteLength) {
    let end = Math.min(start + RUN_MESSAGE_CHUNK_BYTES, bytes.byteLength);
    // Never end inside a multi-byte sequence: back up over continuation bytes.
    while (end < bytes.byteLength && ((bytes[end] ?? 0) & 0xc0) === 0x80)
      end -= 1;
    chunks.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return chunks;
}

/** Decide how a run's whole final message is stored: inline when it fits the
 * preview, otherwise a preview plus content-addressed out-of-line chunks.
 * Throws for a message over `RUN_MESSAGE_MAX_BYTES`; the Work API refuses
 * such a completion at its boundary before it gets here. */
export function splitRunMessage(message: string): SplitRunMessage {
  if (message.length <= RUN_MESSAGE_PREVIEW_MAX) return { preview: message };
  // UTF-8 encoding replaces any lone surrogate, so the stored text is the
  // well-formed message that the digest and every read describe.
  const bytes = Buffer.from(message, 'utf8');
  const whole = bytes.toString('utf8');
  if (bytes.byteLength > RUN_MESSAGE_MAX_BYTES)
    throw new RangeError(
      `Run message is ${bytes.byteLength} bytes; the bound is ${RUN_MESSAGE_MAX_BYTES}`,
    );
  const chunks = chunksOf(bytes);
  return {
    preview: previewOf(whole),
    overflow: {
      ref: {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        chars: whole.length,
        bytes: bytes.byteLength,
        chunks: chunks.length,
      },
      chunks,
    },
  };
}

/** Rebuild a stored message, or undefined unless every chunk is present and
 * the joined bytes match the recorded digest and size. */
export function joinRunMessage(
  overflow: RunMessageOverflow,
  chunks: readonly (string | undefined)[],
): string | undefined {
  if (
    chunks.length !== overflow.chunks ||
    chunks.some((chunk) => chunk === undefined)
  )
    return undefined;
  const whole = chunks.join('');
  const bytes = Buffer.from(whole, 'utf8');
  return bytes.byteLength === overflow.bytes &&
    createHash('sha256').update(bytes).digest('hex') === overflow.sha256
    ? whole
    : undefined;
}

/** Store a result's whole message out of line when it overflows the inline
 * preview, and return the result to record on the run document. Call it
 * before settling: the chunks are content-addressed, so a completion that
 * is later refused leaves only an unreferenced copy behind. */
export async function externalizeRunMessage(
  store: Pick<OrchestratorStore, 'writeRunMessage'>,
  runId: string,
  result: RunResult,
): Promise<RunResult> {
  const { messageOverflow: _ignored, ...rest } = result;
  if (result.message === undefined) return rest;
  const split = splitRunMessage(result.message);
  if (split.overflow === undefined) return { ...rest, message: split.preview };
  await store.writeRunMessage({
    runId,
    overflow: split.overflow.ref,
    chunks: split.overflow.chunks,
  });
  return {
    ...rest,
    message: split.preview,
    messageOverflow: split.overflow.ref,
  };
}

/** The run's whole final message: the inline one, or the out-of-line copy
 * its overflow names. Falls back to the inline preview only when the stored
 * copy is unreadable (missing, mismatched or a failed read), which
 * `onMissing` reports. */
export async function readFullRunMessage(
  store: Pick<OrchestratorStore, 'readRunMessage'>,
  run: Pick<Run, 'runId' | 'result'>,
  onMissing?: (runId: string) => void,
): Promise<string | undefined> {
  const overflow = run.result?.messageOverflow;
  if (overflow === undefined) return run.result?.message;
  const whole = await store
    .readRunMessage({ runId: run.runId, overflow })
    .catch(() => undefined);
  if (whole === undefined) onMissing?.(run.runId);
  return whole ?? run.result?.message;
}

/** Runs whose `result.message` is the whole message. A run that has been
 * restored drops `messageOverflow`, so its view no longer advertises a
 * preview; one whose stored copy is unreadable keeps both, honestly. */
export async function withFullRunMessages<
  T extends Pick<Run, 'runId' | 'result'>,
>(
  store: Pick<OrchestratorStore, 'readRunMessage'>,
  runs: readonly T[],
  onMissing?: (runId: string) => void,
): Promise<T[]> {
  return Promise.all(
    runs.map(async (run) => {
      const overflow = run.result?.messageOverflow;
      if (run.result === undefined || overflow === undefined) return run;
      const whole = await store
        .readRunMessage({ runId: run.runId, overflow })
        .catch(() => undefined);
      if (whole === undefined) {
        onMissing?.(run.runId);
        return run;
      }
      const { messageOverflow: _restored, ...result } = run.result;
      return { ...run, result: { ...result, message: whole } };
    }),
  );
}
