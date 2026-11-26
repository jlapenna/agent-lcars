import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fileGithubStreamCheckpoints } from './github-stream-state';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function directory() {
  const d = mkdtempSync(path.join(os.tmpdir(), 'lcars-github-checkpoints-'));
  directories.push(d);
  return d;
}
describe('GitHub read checkpoints across host restart', () => {
  it('recovers the last successful watermark privately after restart', () => {
    const d = directory(),
      key = 'github:pr:acme/widgets#8',
      at = '2026-11-26T00:00:00.000Z';
    const first = fileGithubStreamCheckpoints(d);
    expect(first.get(key)).toBeUndefined();
    first.set(key, at);
    expect(fileGithubStreamCheckpoints(d).get(key)).toBe(at);
    expect(
      statSync(path.join(d, 'github-stream-checkpoints.json')).mode & 0o777,
    ).toBe(0o600);
    expect(
      readFileSync(path.join(d, 'github-stream-checkpoints.json'), 'utf8'),
    ).not.toContain('token');
  });
  it('fails visibly on corrupt state rather than claiming an empty successful cursor', () => {
    const d = directory();
    writeFileSync(path.join(d, 'github-stream-checkpoints.json'), 'bad json');
    expect(() =>
      fileGithubStreamCheckpoints(d).get('github:pr:acme/widgets#8'),
    ).toThrow('Cannot read');
  });
});
