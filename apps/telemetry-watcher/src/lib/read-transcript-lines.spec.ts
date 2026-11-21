import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readTranscriptLines,
  readTranscriptLinesFromFd,
} from './read-transcript-lines';

const temporaryPaths: string[] = [];

function writeFixture(contents: string | Buffer): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-lines-'));
  temporaryPaths.push(directory);
  const filePath = path.join(directory, 'session.jsonl');
  fs.writeFileSync(filePath, contents);
  return filePath;
}

afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
  }
});

describe('readTranscriptLines', () => {
  it('streams lines across buffer and UTF-8 character boundaries', () => {
    const prefix = 'x'.repeat(64 * 1024 - 2);
    const filePath = writeFixture(`${prefix}é\nsecond\n`);

    expect(Array.from(readTranscriptLines(filePath))).toEqual([
      `${prefix}é`,
      'second',
    ]);
  });

  it('preserves a valid record larger than the read buffer', () => {
    const filePath = writeFixture(`${'x'.repeat(5 * 1024 * 1024)}\nvalid\n`);

    expect(Array.from(readTranscriptLines(filePath))).toEqual([
      'x'.repeat(5 * 1024 * 1024),
      'valid',
    ]);
  });
});

describe('readTranscriptLinesFromFd', () => {
  it('reports exact byte offsets across multi-byte UTF-8 characters and repeatable fd passes', () => {
    const line1 = '{"msg":"héllo 🚀"}';
    const line2 = '{"msg":"€uro"}';
    const raw = `${line1}\n${line2}`;
    const filePath = writeFixture(raw);
    const fd = fs.openSync(filePath, 'r');
    try {
      const firstPass = Array.from(readTranscriptLinesFromFd(fd));
      const secondPass = Array.from(readTranscriptLinesFromFd(fd));
      const line1Bytes = Buffer.byteLength(`${line1}\n`, 'utf8');
      const totalBytes = Buffer.byteLength(raw, 'utf8');
      expect(firstPass).toEqual([
        { line: line1, endByteOffset: line1Bytes },
        { line: line2, endByteOffset: totalBytes },
      ]);
      expect(secondPass).toEqual(firstPass);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('accepts lines at the exact maxLineBytes payload ceiling with \\n, \\r\\n, or EOF, and rejects limit + 1', () => {
    // Test across the 64 KiB read buffer boundary so split `\r\n` is exercised too.
    const limit = 64 * 1024;
    const exactPayload = 'a'.repeat(limit);

    for (const raw of [
      `${exactPayload}\nnext\n`,
      `${exactPayload}\r\nnext\r\n`,
      exactPayload,
    ]) {
      const filePath = writeFixture(raw);
      const fd = fs.openSync(filePath, 'r');
      try {
        const lines = Array.from(
          readTranscriptLinesFromFd(fd, { maxLineBytes: limit }),
        );
        expect(lines[0]?.line).toBe(exactPayload);
      } finally {
        fs.closeSync(fd);
      }
    }

    for (const over of [
      `${'a'.repeat(limit + 1)}\n`,
      `${'a'.repeat(limit + 1)}\r\n`,
      'a'.repeat(limit + 1),
    ]) {
      const filePath = writeFixture(over);
      const fd = fs.openSync(filePath, 'r');
      try {
        expect(() =>
          Array.from(readTranscriptLinesFromFd(fd, { maxLineBytes: limit })),
        ).toThrow('transcript-line-too-large');
      } finally {
        fs.closeSync(fd);
      }
    }
  });

  it('rejects a growing stream that exceeds maxBytes mid-pass', () => {
    const filePath = writeFixture(`${'a'.repeat(100)}\n${'b'.repeat(100)}\n`);
    const fd = fs.openSync(filePath, 'r');
    try {
      expect(() =>
        Array.from(readTranscriptLinesFromFd(fd, { maxBytes: 150 })),
      ).toThrow('archive-size');
    } finally {
      fs.closeSync(fd);
    }
  });
});
