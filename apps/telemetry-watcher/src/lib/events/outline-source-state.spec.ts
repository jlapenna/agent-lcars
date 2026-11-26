import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { fileOutlineTextHashes } from './outline-source-state';

const directories: string[] = [];
afterEach(() => {
  for (const d of directories.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
function directory() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'outline-hashes-'));
  directories.push(d);
  return d;
}
it('restores private hash state after a process restart', () => {
  const d = directory();
  const id = '00000000-0000-4000-8000-000000000001';
  const baseline = {
    hash: 'a'.repeat(64),
    updatedAt: '2026-11-26T01:00:00Z',
    origin: 'own' as const,
  };
  fileOutlineTextHashes(d).put(id, baseline);
  expect(fileOutlineTextHashes(d).get(id)).toEqual(baseline);
  expect(
    fs.statSync(path.join(d, 'outline-text-hashes.json')).mode & 0o777,
  ).toBe(0o600);
});
it('fails visibly on corrupt saved hashes instead of forgetting edit baselines', () => {
  const d = directory();
  fs.writeFileSync(path.join(d, 'outline-text-hashes.json'), 'not JSON');
  expect(() => fileOutlineTextHashes(d)).toThrow('unreadable');
});
