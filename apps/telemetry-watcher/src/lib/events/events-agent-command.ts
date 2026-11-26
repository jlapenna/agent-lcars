import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Duration, PubSub } from '@google-cloud/pubsub';

import {
  callHerdrCore,
  herdrCoreSocketPath,
  processStartIdentity,
} from '../hook/herdr-pane';
import {
  DEFAULT_TELEMETRY_PROJECT_ID,
  loadHookClientConfig,
} from '../hook/hook-config';
import { readHookSessionState } from '../hook/hook-state';
import { SESSION_STATE_DIRECTORY } from '../session-title-paths';
import { fileDeliveredStore } from './delivered-store';
import {
  DeliveryAgent,
  type DeliveryLog,
  type InboundDelivery,
  type UndeliverableHandler,
} from './delivery-agent';
import {
  githubPreviewApi,
  openGithubPreviewListener,
} from './github-stream-process';
import { fileGithubStreamCheckpoints } from './github-stream-state';
import { GithubStreams } from './github-streams';
import {
  defaultRunFile,
  herdrCoreSend,
  resolveHcBinary,
} from './herdr-core-send';
import { eventsSocketPath } from './local-protocol';
import {
  type EventsSocketServer,
  handleLocalRequest,
  serveEventsSocket,
} from './local-socket-server';
import { DeliveryMetrics } from './metrics';
import {
  listRecentHookSessions,
  SESSION_REPORT_TICK_MS,
  SESSION_REPORTS_FILE,
  SessionReporter,
} from './session-reporter';
import {
  serviceAccountIdTokens,
  type SubscriptionForwarder,
  workApiSubscriptionForwarder,
} from './subscribe-forwarder';
import { checkTerminalTarget } from './terminal-target';

export const EVENTS_AGENT_USAGE = `Usage: lcars events agent

Runs this host's event delivery agent (#3538): pulls the host's Pub/Sub
subscription agent-events-<host>, waits until the subscribing session's
herdr-core terminal still runs that session and is at its prompt, types the
notice with \`hc send\`, confirms a turn started, then acks. It serves
\`lcars session subscribe|subscriptions|unsubscribe\` on a Unix socket only
this user can open, forwarding each request to the LCARS Work API as this
host's agent-events identity, and reports this host's sessions going idle
or ending to LCARS as lcars:session events. A long-running user service; it
serves Prometheus metrics on loopback.

Environment:
  LCARS_EVENTS_CREDENTIALS_FILE  the host's agent-events service-account key
                                 (default ~/.config/agent-lcars/events-key.json;
                                 without one the agent stays idle)
  LCARS_EVENTS_PROJECT_ID        Google Cloud project (default agent-lcars)
  LCARS_EVENTS_SUBSCRIPTION      subscription (default agent-events-<host>)
  LCARS_EVENTS_METRICS_PORT      loopback metrics port (default 9478)
  LCARS_EVENTS_SOCKET            local subscribe socket
                                 (default $XDG_RUNTIME_DIR/agent-lcars/events.sock)
  LCARS_CONSOLE_URL, LCARS_URL   the LCARS console (default https://lcars.jlapenna.net)
  LCARS_AUDIENCE                 Work API ID-token audience (default agent-lcars-work)
  AGENT_TELEMETRY_HOST           host name, as the telemetry hook reports it
  HC                             the herdr-core client (default ~/.local/bin/hc)`;

/** The host's key, installed the way the telemetry writer key is. */
export const EVENTS_KEY_FILE = path.join(
  '.config',
  'agent-lcars',
  'events-key.json',
);
export const DEFAULT_METRICS_PORT = 9478;
export const DEFAULT_CONSOLE_ORIGIN = 'https://lcars.jlapenna.net';
export const DEFAULT_WORK_AUDIENCE = 'agent-lcars-work';
const EVENTS_STATE_SUBDIRECTORY = 'events-agent';

export interface EventsAgentConfig {
  readonly host: string;
  readonly projectId: string;
  readonly subscription: string;
  /** Absent: no credential, so the agent is configured off and idles. */
  readonly credentialsFile?: string;
  /** Where the hook keeps session state; the agent reads it. */
  readonly stateDirectory: string;
  readonly metricsPort: number;
  readonly hc: string;
  /** Absent: the user has no runtime directory, so no local socket. */
  readonly socketPath?: string;
  /** The console the Work API is served from. */
  readonly consoleOrigin: string;
  /** The Work API's Google ID-token audience. */
  readonly audience: string;
}

export type EventsAgentConfigResult =
  | { readonly ok: true; readonly config: EventsAgentConfig }
  | { readonly ok: false; readonly error: string };

export function loadEventsAgentConfig(
  env: NodeJS.ProcessEnv,
  home: string,
  exists: (filePath: string) => boolean = (filePath) => fs.existsSync(filePath),
  hostname: () => string = os.hostname,
  uid: number | null = process.getuid?.() ?? null,
): EventsAgentConfigResult {
  const host = loadHookClientConfig({
    env,
    homeDirectory: home,
    hostname,
  }).host;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(host)) {
    return {
      ok: false,
      error: `host ${JSON.stringify(host)} is not a delivery host name`,
    };
  }
  const rawPort = env['LCARS_EVENTS_METRICS_PORT']?.trim();
  const metricsPort = rawPort ? Number(rawPort) : DEFAULT_METRICS_PORT;
  if (
    !Number.isSafeInteger(metricsPort) ||
    metricsPort < 1 ||
    metricsPort > 65_535
  ) {
    return { ok: false, error: 'LCARS_EVENTS_METRICS_PORT must be a TCP port' };
  }
  const configuredKey = env['LCARS_EVENTS_CREDENTIALS_FILE']?.trim();
  const defaultKey = path.join(home, EVENTS_KEY_FILE);
  const credentialsFile = configuredKey
    ? exists(configuredKey)
      ? configuredKey
      : undefined
    : exists(defaultKey)
      ? defaultKey
      : undefined;
  const socketPath = eventsSocketPath(env, uid);
  return {
    ok: true,
    config: {
      host,
      projectId:
        env['LCARS_EVENTS_PROJECT_ID']?.trim() || DEFAULT_TELEMETRY_PROJECT_ID,
      subscription:
        env['LCARS_EVENTS_SUBSCRIPTION']?.trim() || `agent-events-${host}`,
      ...(credentialsFile && { credentialsFile }),
      stateDirectory: path.join(home, SESSION_STATE_DIRECTORY),
      metricsPort,
      hc: resolveHcBinary(env, home),
      ...(socketPath && { socketPath }),
      consoleOrigin:
        env['LCARS_CONSOLE_URL']?.trim() ||
        env['LCARS_URL']?.trim() ||
        DEFAULT_CONSOLE_ORIGIN,
      audience: env['LCARS_AUDIENCE']?.trim() || DEFAULT_WORK_AUDIENCE,
    },
  };
}

export interface PullHandlers {
  readonly onMessage: (message: InboundDelivery) => void;
  /** The stream closed for good; the agent opens a new one. */
  readonly onError: (error: Error) => void;
  /** A stream ended and the client is reopening it. */
  readonly onStreamRetry: () => void;
}

export interface PullSubscriber {
  close(): Promise<void>;
}

export type OpenPullSubscriber = (
  config: EventsAgentConfig,
  handlers: PullHandlers,
) => PullSubscriber;

/** Holds a streaming pull of the host's subscription with
 * `@google-cloud/pubsub`. The client lives only in the events agent's own
 * bundle, so other `lcars` commands never load it. */
export const openPubSubSubscriber: OpenPullSubscriber = (config, handlers) => {
  const pubsub = new PubSub({
    projectId: config.projectId,
    keyFilename: config.credentialsFile,
  });
  const subscription = pubsub.subscription(config.subscription, {
    flowControl: { maxMessages: 64, allowExcessMessages: false },
    // Longer than a delivery is held while its session is busy.
    maxExtensionTime: Duration.from({ minutes: 30 }),
  });
  subscription.on('message', (message) => {
    handlers.onMessage({
      attributes: message.attributes,
      data: message.data,
      publishTime: new Date(message.publishTime.getTime()),
      ack: async () => {
        await message.ackWithResponse();
      },
      nack: async () => {
        await message.nackWithResponse();
      },
    });
  });
  subscription.on('error', (error) => handlers.onError(error));
  subscription.on('debug', (debug) => {
    if (/has ended with status/u.test(debug.message)) handlers.onStreamRetry();
  });
  return {
    close: async () => {
      await subscription.close();
      await pubsub.close();
    },
  };
};

export interface EventsAgentRuntime {
  readonly openSubscriber: OpenPullSubscriber;
  readonly agent: Pick<DeliveryAgent, 'handle'>;
  readonly metrics: DeliveryMetrics;
  readonly log: DeliveryLog;
  readonly now: () => number;
  readonly setInterval: (fn: () => void, ms: number) => () => void;
  readonly setTimeout: (fn: () => void, ms: number) => () => void;
}

export const HEALTH_TICK_MS = 30_000;
const REOPEN_INITIAL_MS = 5_000;
const REOPEN_MAX_MS = 5 * 60_000;

/**
 * Keeps a streaming pull open and feeds each message to the delivery agent.
 * A stream that closes with an error is reopened with backoff. The last
 * successful pull advances on every message, and on every health tick the
 * stream stayed open without a failure, so an idle subscription still shows
 * a healthy pull. Resolves a stop function.
 */
export function startPulling(
  config: EventsAgentConfig,
  runtime: EventsAgentRuntime,
): () => Promise<void> {
  const { metrics, log } = runtime;
  let subscriber: PullSubscriber | undefined;
  let stopped = false;
  let troubledSinceTick = false;
  let reopenDelay = REOPEN_INITIAL_MS;
  let cancelReopen: (() => void) | undefined;
  const markPulled = () => {
    metrics.lastSuccessfulPull = Math.floor(runtime.now() / 1000);
  };

  const open = () => {
    cancelReopen = undefined;
    if (stopped) return;
    troubledSinceTick = false;
    const current = runtime.openSubscriber(config, {
      onMessage: (message) => {
        if (current !== subscriber) return;
        markPulled();
        reopenDelay = REOPEN_INITIAL_MS;
        void runtime.agent.handle(message).catch((error: unknown) => {
          log({
            level: 'error',
            msg: 'delivery crashed',
            error: error instanceof Error ? error.name : 'error',
          });
        });
      },
      onError: (error) => {
        if (current !== subscriber) return;
        subscriber = undefined;
        metrics.streamOpen = 0;
        metrics.streamErrors += 1;
        troubledSinceTick = true;
        log({
          level: 'error',
          msg: 'streaming pull failed; reopening',
          error: error.name,
          code: (error as { code?: unknown }).code,
          reopenInMs: reopenDelay,
        });
        void current.close().catch(() => undefined);
        cancelReopen = runtime.setTimeout(open, reopenDelay);
        reopenDelay = Math.min(reopenDelay * 2, REOPEN_MAX_MS);
      },
      onStreamRetry: () => {
        if (current === subscriber) troubledSinceTick = true;
      },
    });
    subscriber = current;
    metrics.streamOpen = 1;
    log({
      level: 'info',
      msg: 'streaming pull open',
      subscription: config.subscription,
    });
  };

  const cancelTick = runtime.setInterval(() => {
    if (subscriber && !troubledSinceTick) {
      markPulled();
      reopenDelay = REOPEN_INITIAL_MS;
    }
    troubledSinceTick = false;
  }, HEALTH_TICK_MS);
  open();

  return async () => {
    stopped = true;
    cancelTick();
    cancelReopen?.();
    const current = subscriber;
    subscriber = undefined;
    metrics.streamOpen = 0;
    await current?.close();
  };
}

/** Logs the undeliverable delivery; the source's fallback (an Outline thread
 * reply, say) is wired here in a later slice. */
export const recordOnlyUndeliverable: UndeliverableHandler = async () =>
  undefined;

export function jsonLineLog(write: (line: string) => void): DeliveryLog {
  return (record) => {
    write(`${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`);
  };
}

export interface EventsAgentProcess {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly serveMetrics: (
    metrics: DeliveryMetrics,
    port: number,
  ) => Promise<{ close(): void }>;
  /** Resolves when the process is asked to stop. */
  readonly stopSignal: () => Promise<void>;
  readonly openSubscriber?: OpenPullSubscriber;
  readonly serveSocket?: typeof serveEventsSocket;
  readonly createForwarder?: (
    config: EventsAgentConfig & { readonly credentialsFile: string },
  ) => SubscriptionForwarder;
}

export const workApiForwarderFor = (
  config: EventsAgentConfig & { readonly credentialsFile: string },
): SubscriptionForwarder =>
  workApiSubscriptionForwarder({
    origin: config.consoleOrigin,
    fetch: globalThis.fetch,
    idToken: serviceAccountIdTokens(config.credentialsFile, config.audience),
  });

/** Serves the local socket, counting and logging each request by outcome. */
async function openLocalSocket(
  config: EventsAgentConfig,
  forwarder: SubscriptionForwarder | undefined,
  serve: typeof serveEventsSocket,
  metrics: DeliveryMetrics,
  log: DeliveryLog,
): Promise<EventsSocketServer | undefined> {
  if (!config.socketPath) {
    log({
      level: 'warn',
      msg: 'no runtime directory; lcars session subscribe is unavailable',
    });
    return undefined;
  }
  return serve(
    config.socketPath,
    async (raw) => {
      const { request, response } = await handleLocalRequest(raw, forwarder);
      const op = request?.op ?? 'invalid';
      const outcome = response.ok ? 'ok' : response.error;
      metrics.countLocalRequest(op, outcome);
      log({
        level: response.ok ? 'info' : 'warn',
        msg: 'local request',
        op,
        outcome,
        ...(request && 'sessionId' in request && request.sessionId
          ? { sessionId: request.sessionId }
          : {}),
      });
      return response;
    },
    log,
  );
}

/** `lcars events agent`. Resolves an exit code once stopped. */
export async function executeEventsAgentCommand(
  argv: readonly string[],
  proc: EventsAgentProcess,
): Promise<number> {
  if (
    argv[0] !== 'events' ||
    argv[1] !== 'agent' ||
    argv.length > 3 ||
    (argv.length === 3 && argv[2] !== '--help')
  ) {
    proc.stderr(`${EVENTS_AGENT_USAGE}\n`);
    return 2;
  }
  if (argv[2] === '--help') {
    proc.stdout(`${EVENTS_AGENT_USAGE}\n`);
    return 0;
  }
  const loaded = loadEventsAgentConfig(proc.env, proc.home);
  if (!loaded.ok) {
    proc.stderr(`lcars events agent: ${loaded.error}\n`);
    return 2;
  }
  const { config } = loaded;
  const log = jsonLineLog(proc.stdout);
  const metrics = new DeliveryMetrics();
  const server = await proc.serveMetrics(metrics, config.metricsPort);
  log({
    level: 'info',
    msg: 'events agent started',
    host: config.host,
    subscription: config.subscription,
    configured: config.credentialsFile !== undefined,
    metricsPort: config.metricsPort,
  });

  const { credentialsFile } = config;
  const baseForwarder = credentialsFile
    ? (proc.createForwarder ?? workApiForwarderFor)({
        ...config,
        credentialsFile,
      })
    : undefined;
  // Injected test forwarders keep their narrow transport; production ones
  // also publish normalized native GitHub events.
  const githubStreams = baseForwarder?.reportGithub
    ? new GithubStreams({
        forwarder: baseForwarder,
        api: githubPreviewApi,
        checkpoints: fileGithubStreamCheckpoints(
          path.join(config.stateDirectory, EVENTS_STATE_SUBDIRECTORY),
        ),
        open: openGithubPreviewListener,
        metrics,
        log,
        now: Date.now,
      })
    : undefined;
  const forwarder = githubStreams?.forwarder ?? baseForwarder;
  if (githubStreams) {
    // One startup restore; failed registrations remain visible and retry on
    // their source. A failed list is reported and retried with bounded backoff.
    void githubStreams.restore().catch(() =>
      log({
        level: 'error',
        msg: 'could not restore GitHub stream registrations',
        component: 'github-stream',
      }),
    );
  }
  let socket: EventsSocketServer | undefined;
  try {
    socket = await openLocalSocket(
      config,
      forwarder,
      proc.serveSocket ?? serveEventsSocket,
      metrics,
      log,
    );
  } catch (error) {
    log({
      level: 'error',
      msg: 'could not open the local subscribe socket',
      error: error instanceof Error ? error.message : String(error),
    });
    await githubStreams?.stop();
    server.close();
    return 1;
  }

  let stop: (() => Promise<void>) | undefined;
  let stopReporting: (() => void) | undefined;
  if (config.credentialsFile && forwarder) {
    metrics.configured = 1;
    const socketPath = herdrCoreSocketPath(proc.env, proc.home);
    const eventsState = path.join(
      config.stateDirectory,
      EVENTS_STATE_SUBDIRECTORY,
    );
    const checkTarget = (sessionId: string) =>
      checkTerminalTarget(
        {
          readSession: (id) => readHookSessionState(config.stateDirectory, id),
          getTerminal: (address) =>
            callHerdrCore(socketPath, 'terminal.get', { terminal: address }),
          processStart: (pid) => processStartIdentity(pid),
        },
        sessionId,
      );
    const agent = new DeliveryAgent({
      host: config.host,
      checkTarget,
      send: (address, text) =>
        herdrCoreSend(defaultRunFile, config.hc, address, text),
      delivered: fileDeliveredStore(eventsState),
      onUndeliverable: recordOnlyUndeliverable,
      metrics,
      log,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    stop = startPulling(config, {
      openSubscriber: proc.openSubscriber ?? openPubSubSubscriber,
      agent,
      metrics,
      log,
      now: Date.now,
      setInterval: (fn, ms) => {
        const handle = setInterval(fn, ms);
        return () => clearInterval(handle);
      },
      setTimeout: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        return () => clearTimeout(handle);
      },
    });
    const reporter = new SessionReporter({
      listSessions: () =>
        listRecentHookSessions(config.stateDirectory, Date.now()),
      checkTarget,
      report: (sessionId, kind, occurredAt) =>
        forwarder.reportSession(sessionId, kind, occurredAt),
      reported: fileDeliveredStore(eventsState, Date.now, SESSION_REPORTS_FILE),
      metrics,
      log,
      now: Date.now,
    });
    const reportTimer = setInterval(() => {
      void reporter.tick().catch((error: unknown) => {
        log({
          level: 'error',
          msg: 'session report tick crashed',
          error: error instanceof Error ? error.name : 'error',
        });
      });
    }, SESSION_REPORT_TICK_MS);
    stopReporting = () => clearInterval(reportTimer);
  } else {
    log({
      level: 'info',
      msg: 'no agent-events credential on this host; idle',
    });
  }

  await proc.stopSignal();
  log({ level: 'info', msg: 'events agent stopping' });
  stopReporting?.();
  await githubStreams?.stop();
  await stop?.();
  await socket?.close();
  server.close();
  return 0;
}
