import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { OutlineSourceJob } from '@agent-lcars/work';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeliveryMetrics } from './metrics';
import { outlineJobHandler } from './outline-job-handler';
import { openOutlineJobInbox } from './outline-job-inbox';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const job: OutlineSourceJob = {
  type: 'outline-fallback',
  id: uuid(1),
  documentId: uuid(2),
};
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { force: true, recursive: true });
});

function fixture(host = 'pike') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-outline-'));
  directories.push(directory);
  const processed = new Set<string>();
  const metrics = new DeliveryMetrics();
  const handle = vi.fn<(job: OutlineSourceJob) => Promise<void>>(
    async () => undefined,
  );
  const deliver = vi.fn(async () => 'delivered' as const);
  const log = vi.fn();
  let now = 10_000;
  const deps = {
    host,
    outline: {
      inbox: openOutlineJobInbox(directory),
      source: { handle },
    },
    metrics,
    deliver,
    log,
    now: () => now,
    delivered: {
      has: (id: string) => processed.has(id),
      record: (id: string) => {
        processed.add(id);
      },
    },
  };
  const message = (body: OutlineSourceJob = job) => ({
    attributes: { host, source: 'outline' },
    data: Buffer.from(JSON.stringify(body)),
    publishTime: new Date(now),
    ack: vi.fn(async () => undefined),
    nack: vi.fn(async () => undefined),
  });
  return {
    deps,
    directory,
    handle,
    metrics,
    deliver,
    processed,
    message,
    log,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('Pike Outline inbox', () => {
  it('acks a burst while the source is held and keeps ordinary delivery flowing', async () => {
    const f = fixture();
    const source = outlineJobHandler(f.deps);
    const releases: (() => void)[] = [];
    f.handle.mockImplementation(
      () => new Promise<void>((resolve) => releases.push(resolve)),
    );
    // Exceed the ordinary delivery stream's 64-message window. Two distinct
    // documents consume the local workers and the rest wait on disk.
    const messages = Array.from({ length: 65 }, (_, i) =>
      f.message({ ...job, id: uuid(i + 10), documentId: uuid(i + 100) }),
    );
    await Promise.all(messages.map((message) => source.handle(message)));
    expect(f.handle).toHaveBeenCalledTimes(2);
    expect(f.metrics.outlineInFlight).toBe(65);
    for (const m of messages) {
      expect(m.ack).toHaveBeenCalledOnce();
      expect(m.nack).not.toHaveBeenCalled();
    }
    const terminal = f.message();
    terminal.attributes.source = 'session';
    await source.handle(terminal);
    expect(f.deliver).toHaveBeenCalledWith(terminal);

    const stopping = source.stop();
    releases.forEach((release) => release());
    await stopping;
    expect(f.handle).toHaveBeenCalledTimes(2);

    const restored = openOutlineJobInbox(f.directory);
    expect(restored.entries.size).toBe(63);
    f.handle.mockResolvedValue(undefined);
    const restarted = outlineJobHandler({
      ...f.deps,
      outline: { ...f.deps.outline, inbox: restored },
    });
    restarted.pump();
    await vi.waitFor(() => expect(restored.entries.size).toBe(0));
    await restarted.stop();
    expect(f.processed.size).toBe(65);
  });

  it('refuses another host and arbitrary extra payload text', async () => {
    const f = fixture('laforge');
    expect(await outlineJobHandler(f.deps).handle(f.message())).toBe('invalid');
    expect(f.handle).not.toHaveBeenCalled();
    const p = fixture();
    const raw = p.message();
    raw.data = Buffer.from(
      JSON.stringify({ ...job, text: 'external instruction' }),
    );
    expect(await outlineJobHandler(p.deps).handle(raw)).toBe('invalid');
    expect(p.handle).not.toHaveBeenCalled();
    expect(p.deps.outline.inbox.entries.size).toBe(0);
  });

  it('backs off a failed job while later notices can still run', async () => {
    const f = fixture();
    const source = outlineJobHandler(f.deps);
    f.handle.mockRejectedValueOnce(new Error('private response'));
    const first = f.message();
    await source.handle(first);
    expect(first.ack).toHaveBeenCalledOnce();
    expect(first.nack).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.metrics.outlineSourcesFailed).toBe(1));
    expect(f.processed.size).toBe(0);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('private response');
    const later = { ...job, id: uuid(3) };
    await source.handle(f.message(later));
    await vi.waitFor(() => expect(f.processed.has(later.id)).toBe(true));
    expect(f.handle.mock.calls).toEqual([[job], [later]]);
    f.advance(30_000);
    source.pump();
    await vi.waitFor(() => expect(f.metrics.outlineInFlight).toBe(0));
    expect(f.metrics.outlineSourcesFailed).toBe(0);
    expect(f.handle.mock.calls).toEqual([[job], [later], [job]]);
    expect(await source.handle(f.message())).toBe('duplicate');
  });

  it('shares a durable entry across concurrent redelivery', async () => {
    const f = fixture();
    let release!: () => void;
    f.handle.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const source = outlineJobHandler(f.deps);
    await Promise.all([source.handle(f.message()), source.handle(f.message())]);
    expect(f.metrics.outlineInFlight).toBe(1);
    expect(f.metrics.outlineOldestPending).toBe(10);
    expect(f.handle).toHaveBeenCalledOnce();
    release();
    await source.stop();
    expect(f.metrics.outlineInFlight).toBe(0);
    expect(f.metrics.outlineOldestPending).toBe(0);
  });

  it('keeps the broker copy when durable admission fails', async () => {
    const f = fixture();
    vi.spyOn(f.deps.outline.inbox, 'enqueue').mockImplementationOnce(() => {
      throw new Error('inbox full or unavailable');
    });
    const m = f.message();
    expect(await outlineJobHandler(f.deps).handle(m)).toBe('retried');
    expect(m.ack).not.toHaveBeenCalled();
    expect(m.nack).toHaveBeenCalledOnce();
    expect(f.metrics.outlineSourcesFailed).toBe(1);
    expect(f.handle).not.toHaveBeenCalled();
  });
});
