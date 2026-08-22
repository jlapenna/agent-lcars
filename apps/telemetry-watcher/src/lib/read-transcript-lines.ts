import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';

const BUFFER_BYTES = 64 * 1024;

/**
 * Yield a UTF-8 JSONL file one line at a time without materializing either
 * the whole file or a `split('\n')` array. This is important for long Codex
 * rollouts: a single transcript can be hundreds of MiB while its reduced
 * session summary is tiny.
 */
export function* readTranscriptLines(filePath: string): Generator<string> {
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(BUFFER_BYTES);
  const decoder = new StringDecoder('utf8');
  let remainder = '';

  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;

      const chunk = decoder.write(buffer.subarray(0, bytesRead));

      let start = 0;
      while (true) {
        const newline = chunk.indexOf('\n', start);
        if (newline === -1) break;
        const line = remainder + chunk.slice(start, newline);
        remainder = '';
        yield line;
        start = newline + 1;
      }

      remainder += chunk.slice(start);
    }

    remainder += decoder.end();
    if (remainder) {
      yield remainder;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}
