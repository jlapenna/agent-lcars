import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';

const BUFFER_BYTES = 64 * 1024;

export interface TranscriptLineSlice {
  line: string;
  /** Exact file byte offset immediately after this line (including its `\n` if present). */
  endByteOffset: number;
}

export interface ReadTranscriptLinesOptions {
  /** Optional total-bytes safety ceiling; throws `'archive-size'` if exceeded. */
  maxBytes?: number;
  /** Optional single-line byte ceiling; throws `'transcript-line-too-large'` before decoding unbounded strings. */
  maxLineBytes?: number;
}

/**
 * Stream UTF-8 JSONL lines from an open file descriptor starting at byte
 * offset 0 using explicit positional `fs.readSync` calls so file offsets are
 * exact and repeatable on the same descriptor.
 */
export function* readTranscriptLinesFromFd(
  fd: number,
  options: ReadTranscriptLinesOptions = {},
): Generator<TranscriptLineSlice> {
  const { maxBytes, maxLineBytes } = options;
  const buffer = Buffer.allocUnsafe(BUFFER_BYTES);
  const decoder = new StringDecoder('utf8');
  let remainder = '';
  let position = 0;
  let currentLineBytes = 0;

  while (true) {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;

    const chunkFileOffset = position;
    position += bytesRead;

    let segStart = 0;
    while (segStart < bytesRead) {
      const newline = buffer.indexOf(0x0a, segStart);
      if (newline === -1 || newline >= bytesRead) {
        break;
      }
      const segment = buffer.subarray(segStart, newline);
      currentLineBytes += segment.length;
      if (maxLineBytes !== undefined && currentLineBytes > maxLineBytes) {
        throw new Error('transcript-line-too-large');
      }
      const endByteOffset = chunkFileOffset + newline + 1;
      if (maxBytes !== undefined && endByteOffset > maxBytes) {
        throw new Error('archive-size');
      }
      // 0x0a never appears inside a multi-byte UTF-8 sequence, so ending the
      // decoder on the pre-newline bytes flushes any malformed tail bytes on
      // this line cleanly and resets the decoder for the next line.
      const line = remainder + decoder.end(segment);
      remainder = '';
      currentLineBytes = 0;
      yield { line, endByteOffset };
      segStart = newline + 1;
    }

    if (segStart < bytesRead) {
      const tail = buffer.subarray(segStart, bytesRead);
      currentLineBytes += tail.length;
      if (maxBytes !== undefined && position > maxBytes) {
        throw new Error('archive-size');
      }
      if (maxLineBytes !== undefined && currentLineBytes > maxLineBytes) {
        throw new Error('transcript-line-too-large');
      }
      remainder += decoder.write(tail);
    } else if (maxBytes !== undefined && position > maxBytes) {
      throw new Error('archive-size');
    }
  }

  remainder += decoder.end();
  if (currentLineBytes > 0 || remainder.length > 0) {
    yield { line: remainder, endByteOffset: position };
  }
}

/**
 * Yield a UTF-8 JSONL file one line at a time without materializing either
 * the whole file or a `split('\n')` array. This is important for long Codex
 * rollouts: a single transcript can be hundreds of MiB while its reduced
 * session summary is tiny.
 */
export function* readTranscriptLines(filePath: string): Generator<string> {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    for (const { line } of readTranscriptLinesFromFd(descriptor)) {
      yield line;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}
