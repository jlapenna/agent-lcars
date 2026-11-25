import { describe, expect, it, vi } from 'vitest';

import type { InboundDelivery } from './delivery-agent';
import {
  type EventsAgentConfig,
  type EventsAgentRuntime,
  executeEventsAgentCommand,
  HEALTH_TICK_MS,
  loadEventsAgentConfig,
  type PullHandlers,
  startPulling,
} from './events-agent-command';
import { DeliveryMetrics } from './metrics';

const HOME = '/home/u';

describe('loadEventsAgentConfig', () => {
  it('uses the host key homegit installs and names the host subscription', () => {
    const loaded = loadEventsAgentConfig(
      { HC: '/opt/hc' },
      HOME,
      (file) => file === `${HOME}/.config/agent-lcars/events-key.json`,
      () => 'pike.lan',
    );
    expect(loaded).toEqual({
      ok: true,
      config: {
        host: 'pike',
        projectId: 'agent-lcars',
        subscription: 'agent-events-pike',
        credentialsFile: `${HOME}/.config/agent-lcars/events-key.json`,
        stateDirectory: `${HOME}/.local/state/agent-lcars`,
        metricsPort: 9478,
        hc: '/opt/hc',
      },
    });
  });

  it('takes overrides from the environment', () => {
    const loaded = loadEventsAgentConfig(
      {
        AGENT_TELEMETRY_HOST: 'laforge',
        LCARS_EVENTS_CREDENTIALS_FILE: '/etc/key.json',
        LCARS_EVENTS_PROJECT_ID: 'other',
        LCARS_EVENTS_SUBSCRIPTION: 'custom',
        LCARS_EVENTS_METRICS_PORT: '9999',
        HC: 'hc',
      },
      HOME,
      () => true,
    );
    expect(loaded.ok && loaded.config).toMatchObject({
      host: 'laforge',
      projectId: 'other',
      subscription: 'custom',
      credentialsFile: '/etc/key.json',
      metricsPort: 9999,
    });
  });

  it('is unconfigured, not failing, without a key', () => {
    const loaded = loadEventsAgentConfig(
      { LCARS_EVENTS_CREDENTIALS_FILE: '/missing.json', HC: 'hc' },
      HOME,
      () => false,
      () => 'pike',
    );
    expect(loaded.ok && loaded.config.credentialsFile).toBeUndefined();
  });

  it.each([
    [{ LCARS_EVENTS_METRICS_PORT: 'abc' }, 'TCP port'],
    [{ AGENT_TELEMETRY_HOST: 'Bad_Host' }, 'not a delivery host name'],
  ])('refuses a bad setting', (env, error) => {
    const loaded = loadEventsAgentConfig(
      { HC: 'hc', ...env },
      HOME,
      () => false,
      () => 'pike',
    );
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.error).toContain(error);
  });
});

const CONFIG: EventsAgentConfig = {
  host: 'pike',
  projectId: 'agent-lcars',
  subscription: 'agent-events-pike',
  credentialsFile: '/k.json',
  stateDirectory: '/s',
  metricsPort: 9478,
  hc: 'hc',
};

function fakeRuntime() {
  const handlers: PullHandlers[] = [];
  const closes: ReturnType<typeof vi.fn>[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  let interval: (() => void) | undefined;
  const clock = { t: 1_000_000_000 };
  const metrics = new DeliveryMetrics();
  const handle = vi.fn(async () => 'delivered' as const);
  const logs: Record<string, unknown>[] = [];
  const runtime: EventsAgentRuntime = {
    openSubscriber: (_config, h) => {
      handlers.push(h);
      const close = vi.fn(async () => undefined);
      closes.push(close);
      return { close };
    },
    agent: { handle },
    metrics,
    log: (record) => logs.push(record),
    now: () => clock.t,
    setInterval: (fn) => {
      interval = fn;
      return () => {
        interval = undefined;
      };
    },
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  return {
    runtime,
    handlers,
    closes,
    timers,
    tick: () => interval?.(),
    hasInterval: () => interval !== undefined,
    clock,
    metrics,
    handle,
    logs,
  };
}

const MESSAGE = {} as InboundDelivery;

describe('startPulling', () => {
  it('opens the stream and hands each message to the agent', () => {
    const fake = fakeRuntime();
    startPulling(CONFIG, fake.runtime);
    expect(fake.metrics.streamOpen).toBe(1);
    fake.handlers[0].onMessage(MESSAGE);
    expect(fake.handle).toHaveBeenCalledWith(MESSAGE);
    expect(fake.metrics.lastSuccessfulPull).toBe(1_000_000);
  });

  it('shows an idle, healthy stream as a recent pull on each tick', () => {
    const fake = fakeRuntime();
    startPulling(CONFIG, fake.runtime);
    fake.clock.t += HEALTH_TICK_MS;
    fake.tick();
    expect(fake.metrics.lastSuccessfulPull).toBe(1_000_030);
  });

  it('does not advance the pull across a tick in which a stream ended', () => {
    const fake = fakeRuntime();
    startPulling(CONFIG, fake.runtime);
    fake.handlers[0].onStreamRetry();
    fake.clock.t += HEALTH_TICK_MS;
    fake.tick();
    expect(fake.metrics.lastSuccessfulPull).toBe(0);
    fake.clock.t += HEALTH_TICK_MS;
    fake.tick();
    expect(fake.metrics.lastSuccessfulPull).toBe(1_000_060);
  });

  it('reopens a failed stream with backoff and ignores the old one', () => {
    const fake = fakeRuntime();
    startPulling(CONFIG, fake.runtime);
    const error = Object.assign(new Error('denied'), { code: 7 });
    fake.handlers[0].onError(error);
    expect(fake.metrics.streamOpen).toBe(0);
    expect(fake.metrics.streamErrors).toBe(1);
    expect(fake.closes[0]).toHaveBeenCalled();
    expect(fake.timers.map((timer) => timer.ms)).toEqual([5_000]);
    expect(fake.logs.at(-1)).toMatchObject({ code: 7 });

    fake.timers[0].fn();
    expect(fake.handlers).toHaveLength(2);
    expect(fake.metrics.streamOpen).toBe(1);
    fake.handlers[0].onMessage(MESSAGE);
    expect(fake.handle).not.toHaveBeenCalled();

    fake.handlers[1].onError(error);
    expect(fake.timers.map((timer) => timer.ms)).toEqual([5_000, 10_000]);
  });

  it('stops: closes the stream and cancels a pending reopen', async () => {
    const fake = fakeRuntime();
    const stop = startPulling(CONFIG, fake.runtime);
    await stop();
    expect(fake.closes[0]).toHaveBeenCalled();
    expect(fake.metrics.streamOpen).toBe(0);
    expect(fake.hasInterval()).toBe(false);

    const again = fakeRuntime();
    const stopAgain = startPulling(CONFIG, again.runtime);
    again.handlers[0].onError(new Error('x'));
    await stopAgain();
    expect(again.timers[0].cancelled).toBe(true);
  });
});

describe('executeEventsAgentCommand', () => {
  function proc(env: NodeJS.ProcessEnv = { HC: 'hc' }) {
    const out: string[] = [];
    const err: string[] = [];
    const close = vi.fn();
    const serveMetrics = vi.fn(async () => ({ close }));
    const openSubscriber = vi.fn(() => ({ close: async () => undefined }));
    return {
      out,
      err,
      close,
      serveMetrics,
      openSubscriber,
      value: {
        env: { AGENT_TELEMETRY_HOST: 'pike', ...env },
        home: '/nonexistent-home',
        stdout: (text: string) => out.push(text),
        stderr: (text: string) => err.push(text),
        serveMetrics,
        stopSignal: async () => undefined,
        openSubscriber,
      },
    };
  }

  it('prints its usage for --help without starting', async () => {
    const p = proc();
    expect(
      await executeEventsAgentCommand(['events', 'agent', '--help'], p.value),
    ).toBe(0);
    expect(p.out.join('')).toContain('Usage: lcars events agent');
    expect(p.serveMetrics).not.toHaveBeenCalled();
  });

  it('refuses anything else', async () => {
    const p = proc();
    expect(await executeEventsAgentCommand(['events', 'other'], p.value)).toBe(
      2,
    );
    expect(p.err.join('')).toContain('Usage: lcars events agent');
  });

  it('idles with metrics and no stream on a host without a key', async () => {
    const p = proc();
    expect(await executeEventsAgentCommand(['events', 'agent'], p.value)).toBe(
      0,
    );
    expect(p.serveMetrics).toHaveBeenCalledWith(
      expect.any(DeliveryMetrics),
      9478,
    );
    expect(p.openSubscriber).not.toHaveBeenCalled();
    const lines = p.out
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => line.msg)).toEqual([
      'events agent started',
      'no agent-events credential on this host; idle',
      'events agent stopping',
    ]);
    expect(p.close).toHaveBeenCalled();
  });

  it('pulls the host subscription when the host has a key', async () => {
    const p = proc({
      HC: 'hc',
      LCARS_EVENTS_CREDENTIALS_FILE: process.execPath,
    });
    expect(await executeEventsAgentCommand(['events', 'agent'], p.value)).toBe(
      0,
    );
    expect(p.openSubscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: 'agent-events-pike',
        credentialsFile: process.execPath,
      }),
      expect.anything(),
    );
  });
});
