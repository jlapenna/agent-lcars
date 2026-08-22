import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { readTranscriptLines } from './read-transcript-lines';

const temporaryPaths: string[] = [];

function writeFixture(contents: string): string {
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
