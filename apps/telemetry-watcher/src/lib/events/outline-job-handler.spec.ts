import type { OutlineSourceJob } from '@agent-lcars/work';
import { describe, expect, it, vi } from 'vitest';

import { DeliveryMetrics } from './metrics';
import { outlineJobHandler } from './outline-job-handler';
import { OutlineSource } from './outline-source';

const doc = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const job: OutlineSourceJob = { type: 'outline-fallback', id, documentId: doc };
function fixture(host = 'pike') {
  const processed = new Set<string>();
  const metrics = new DeliveryMetrics();
  const handle = vi.fn<() => Promise<void>>(async () => undefined);
  const source = { handle } as unknown as OutlineSource;
  const deliver = vi.fn(async () => 'delivered' as const);
  const log = vi.fn();
  const deps = {
    host,
    source: source as OutlineSource | undefined,
    metrics,
    deliver,
    log,
    now: () => 10000,
    delivered: {
      has: (id: string) => processed.has(id),
      record: (id: string) => {
        processed.add(id);
      },
    },
  };
  const message = () => ({
    attributes: { host, source: 'outline' },
    data: Buffer.from(JSON.stringify(job)),
    publishTime: new Date(),
    ack: vi.fn(async () => undefined),
    nack: vi.fn(async () => undefined),
  });
  return { deps, handle, metrics, deliver, processed, message, log };
}
describe('Outline jobs share the existing authenticated pull', () => {
  it('passes ordinary deliveries through unchanged', async () => {
    const f = fixture();
    const m = f.message();
    m.attributes.source = 'session';
    await outlineJobHandler(f.deps)(m);
    expect(f.deliver).toHaveBeenCalledWith(m);
    expect(f.handle).not.toHaveBeenCalled();
  });
  it('refuses another host and arbitrary extra payload text', async () => {
    const f = fixture('laforge');
    const m = f.message();
    expect(await outlineJobHandler(f.deps)(m)).toBe('invalid');
    expect(f.handle).not.toHaveBeenCalled();
    const p = fixture();
    const raw = p.message();
    raw.data = Buffer.from(
      JSON.stringify({ ...job, text: 'external instruction' }),
    );
    expect(await outlineJobHandler(p.deps)(raw)).toBe('invalid');
    expect(p.handle).not.toHaveBeenCalled();
  });
  it('retries a source failure without losing the job, then clears the failure on recovery', async () => {
    const f = fixture();
    const run = outlineJobHandler(f.deps);
    f.handle.mockRejectedValueOnce(new Error('private response'));
    const first = f.message();
    expect(await run(first)).toBe('retried');
    expect(first.nack).toHaveBeenCalledOnce();
    expect(first.ack).not.toHaveBeenCalled();
    expect(f.processed.size).toBe(0);
    expect(f.metrics.outlineSourcesFailed).toBe(1);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('private response');
    expect(await run(f.message())).toBe('delivered');
    expect(f.metrics.outlineSourcesFailed).toBe(0);
    expect(await run(f.message())).toBe('duplicate');
    expect(f.handle).toHaveBeenCalledTimes(2);
  });
  it('shares one processing attempt across concurrent redelivery', async () => {
    const f = fixture();
    let release!: () => void;
    f.handle.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const run = outlineJobHandler(f.deps);
    const early = f.message();
    early.publishTime = new Date(5000);
    const later = f.message();
    later.publishTime = new Date(6000);
    const first = run(early);
    const second = run(later);
    expect(f.metrics.outlineInFlight).toBe(2);
    expect(f.metrics.outlineOldestPending).toBe(5);
    expect(f.handle).toHaveBeenCalledOnce();
    release();
    await Promise.all([first, second]);
    expect(f.handle).toHaveBeenCalledOnce();
    expect(f.metrics.outlineInFlight).toBe(0);
    expect(f.metrics.outlineOldestPending).toBe(0);
  });
  it('keeps missing source configuration distinct from successful idle work', async () => {
    const f = fixture();
    f.deps.source = undefined;
    const m = f.message();
    expect(await outlineJobHandler(f.deps)(m)).toBe('retried');
    expect(m.ack).not.toHaveBeenCalled();
    expect(f.metrics.outlineSourcesFailed).toBe(1);
    expect(f.metrics.outlineJobs).toBe(0);
  });
});
