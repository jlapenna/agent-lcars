import { logger } from '@agent-lcars/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readTimings } from './read-timings';

describe('readTimings', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs each read by label, including failed ones, in one line', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const timings = readTimings('bridge');

    await timings.time('queue', Promise.resolve(1));
    await timings
      .time('spend', Promise.reject(new Error('down')))
      .catch(() => undefined);
    timings.log();

    expect(info).toHaveBeenCalledOnce();
    const [message, fields] = info.mock.calls[0]!;
    expect(message).toBe('agent-lcars: page read timings');
    expect(fields).toMatchObject({
      page: 'bridge',
      totalMs: expect.any(Number),
      reads: { queue: expect.any(Number), spend: expect.any(Number) },
    });
  });
});
