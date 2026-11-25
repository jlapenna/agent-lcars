import { afterEach, describe, expect, it, vi } from 'vitest';

const e2e = vi.hoisted(() => ({ on: false }));
vi.mock('@agent-lcars/util-server', () => ({ isE2eTesting: () => e2e.on }));

import { shareInFlight } from './in-flight';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('shareInFlight', () => {
  afterEach(() => {
    e2e.on = false;
  });

  it('shares one read between concurrent callers and keeps nothing after it settles', async () => {
    const first = deferred<number>();
    const read = vi
      .fn<() => Promise<number>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(2);

    const a = shareInFlight('k', read);
    const b = shareInFlight('k', read);
    first.resolve(1);
    expect(await Promise.all([a, b])).toEqual([1, 1]);
    expect(read).toHaveBeenCalledOnce();

    // Settled: the next caller reads again.
    expect(await shareInFlight('k', read)).toBe(2);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps different keys apart and lets a failed read be retried', async () => {
    const failing = deferred<number>();
    const read = vi
      .fn<() => Promise<number>>()
      .mockReturnValueOnce(failing.promise)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(8);

    const a = shareInFlight('a', read);
    const other = shareInFlight('b', read);
    failing.reject(new Error('down'));
    await expect(a).rejects.toThrow('down');
    expect(await other).toBe(7);
    expect(await shareInFlight('a', read)).toBe(8);
  });

  it('never shares in hermetic E2E', async () => {
    e2e.on = true;
    const read = vi.fn(async () => 1);
    await Promise.all([shareInFlight('k', read), shareInFlight('k', read)]);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
