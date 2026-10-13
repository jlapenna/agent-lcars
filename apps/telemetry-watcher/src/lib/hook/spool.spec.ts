import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { appendToSpool, drainSpool } from './spool';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function tempSpool(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-spool-'));
  dirs.push(dir);
  return path.join(dir, 'spool', 'events.ndjson');
}
const read = (file: string): { n: number }[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { n: number })
    : [];
/** Pending leftovers first, then the live file: the order a drain sends. */
const lines = (file: string) => [
  ...read(path.join(path.dirname(file), 'events.pending.ndjson')),
  ...read(file),
];

describe('spool', () => {
  it('drops the oldest events when the cap is exceeded', () => {
    const file = tempSpool();
    const size = JSON.stringify({ n: 0 }).length + 1;
    for (let n = 0; n < 10; n++) appendToSpool(file, { n }, size * 4);
    expect(lines(file).map((e) => e.n)).toEqual([6, 7, 8, 9]);
  });

  it('drains oldest-first, stops on retry, and preserves later appends', async () => {
    const file = tempSpool();
    for (let n = 0; n < 4; n++) appendToSpool(file, { n });
    const seen: number[] = [];
    const result = await drainSpool(file, async (event) => {
      const n = (event as { n: number }).n;
      seen.push(n);
      if (n === 2) {
        appendToSpool(file, { n: 99 });
        return 'retry';
      }
      return n === 1 ? 'drop' : 'sent';
    });
    expect(seen).toEqual([0, 1, 2]);
    expect(result).toEqual({
      locked: false,
      sent: 1,
      dropped: 1,
      remaining: 3,
    });
    expect(lines(file).map((e) => e.n)).toEqual([2, 3, 99]);
    // The append during the drain landed in a fresh live file, untouched.
    expect(read(file).map((e) => e.n)).toEqual([99]);
    expect(fs.existsSync(path.join(path.dirname(file), 'events.lock'))).toBe(
      false,
    );
  });

  it('refuses to run while a fresh lock exists and ignores a stale one', async () => {
    const file = tempSpool();
    appendToSpool(file, { n: 1 });
    const lock = path.join(path.dirname(file), 'events.lock');
    fs.writeFileSync(lock, '1');
    expect((await drainSpool(file, async () => 'sent')).locked).toBe(true);
    const stale = Date.now() + 10 * 60_000;
    expect(
      (
        await drainSpool(
          file,
          async () => 'sent',
          20,
          () => stale,
        )
      ).locked,
    ).toBe(false);
    expect(lines(file)).toEqual([]);
  });
});
