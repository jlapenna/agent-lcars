import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import telemetry from '../../agents/opencode/lcars-telemetry.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn(async () => undefined),
  stat: vi.fn(),
  writeFile: vi.fn(async () => undefined),
}));

const payloads: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  payloads.length = 0;
  vi.stubEnv('LCARS_RUN_ID', 'owned-disposal-run');
  vi.stubEnv('LCARS_TELEMETRY_CREDENTIALS_FILE', '/owned/unused-credential');
  vi.mocked(readdir).mockResolvedValue([]);
  vi.mocked(mkdtemp).mockResolvedValue('/owned/lcars-opencode-ABC123');
  vi.mocked(spawn).mockImplementation(() => {
    const child = new EventEmitter();
    const stdin = new PassThrough();
    let text = '';
    stdin.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    stdin.on('finish', () => payloads.push(text));
    return Object.assign(child, { stdin, unref: vi.fn() }) as ChildProcess;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function blockedSession() {
  let release!: (value: { data?: { id: string; directory: string } }) => void;
  const blocked = new Promise<{ data?: { id: string; directory: string } }>(
    (resolve) => {
      release = resolve;
    },
  );
  const info = { data: { id: 'owned-session', directory: '/owned/work' } };
  const get = vi
    .fn()
    .mockResolvedValue(info)
    .mockImplementationOnce(() => blocked);
  const messages = vi.fn(async () => ({ data: [] }));
  return { release, info, client: { session: { get, messages } } };
}

it.each([false, true])(
  'hands the final Stop to the detached client before disposal resolves (queued=%s)',
  async (queued) => {
    const f = blockedSession();
    const hooks = await telemetry({
      client: f.client,
      directory: '/owned/work',
    });
    if (queued)
      await hooks.event({
        event: {
          type: 'session.created',
          properties: { info: { id: 'owned-session' } },
        },
      });
    await hooks.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'owned-session' },
      },
    });
    expect(f.client.session.get).toHaveBeenCalledTimes(1);
    let settled = false;
    let handedOffAtShutdown: string[] = [];
    const disposal = Promise.resolve(hooks.dispose?.()).then(() => {
      handedOffAtShutdown = payloads.map(
        (text) => JSON.parse(text).hook_event_name,
      );
      settled = true;
    });
    try {
      await Promise.resolve();
      const heldWhileLookupPending = !settled;
      expect(spawn).not.toHaveBeenCalled();
      f.release(f.info);
      await disposal;
      expect(handedOffAtShutdown).toEqual(
        queued ? ['SessionStart', 'Stop'] : ['Stop'],
      );
      expect(heldWhileLookupPending).toBe(true);
      expect(settled).toBe(true);
      expect(payloads.map((text) => JSON.parse(text).hook_event_name)).toEqual(
        queued ? ['SessionStart', 'Stop'] : ['Stop'],
      );
      expect(vi.mocked(writeFile).mock.calls.map((call) => call[2])).toEqual(
        queued ? [{ mode: 0o600 }, { mode: 0o600 }] : [{ mode: 0o600 }],
      );
      expect(spawn).toHaveBeenLastCalledWith(
        expect.any(String),
        ['hook', 'opencode'],
        { detached: true, stdio: ['pipe', 'ignore', 'ignore'] },
      );
    } finally {
      f.client.session.get.mockResolvedValue({});
      f.release({});
      await disposal;
      await new Promise((resolve) => setImmediate(resolve));
    }
  },
);

it('bounds disposal when the session lookup never answers', async () => {
  vi.useFakeTimers();
  const f = blockedSession();
  const hooks = await telemetry({ client: f.client, directory: '/owned/work' });
  await hooks.event({
    event: { type: 'session.idle', properties: { sessionID: 'owned-session' } },
  });
  let settled = false;
  const disposal = Promise.resolve(hooks.dispose?.()).then(() => {
    settled = true;
  });
  try {
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await disposal;
    expect(settled).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  } finally {
    f.client.session.get.mockResolvedValue({});
    f.release({});
    await disposal;
  }
});
