import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import {
  agentEventSessionIdSchema,
  agentEventSubscriptionIdSchema,
  agentEventSubscriptionRequestSchema,
  agentEventSubscriptionViewSchema,
} from '@agent-lcars/work';
import { z } from 'zod';

/**
 * The local protocol between `lcars session subscribe|subscriptions|
 * unsubscribe` and this host's delivery agent (#3538).
 *
 * One connection carries one request line and one response line, each a
 * JSON object. The socket lives in a directory under the user's runtime
 * directory that only the user can enter (mode 0700) and is itself mode
 * 0600, so only processes running as the same user (or root) can connect.
 * Node exposes no peer-credential check (`SO_PEERCRED`) for Unix sockets,
 * so those permissions are the whole local access check. The host is never
 * part of a request: the agent's own Google identity names it to the
 * console.
 *
 * This module is loaded by the CLI bundle, so it must not import the agent's
 * Google clients.
 */
export const EVENTS_SOCKET_DIRECTORY = 'agent-lcars';
export const EVENTS_SOCKET_FILE = 'events.sock';
/** Far more than any request; bounds what a peer can make either side hold. */
export const MAX_LOCAL_LINE_BYTES = 64 * 1024;

/**
 * Where the delivery agent listens: `LCARS_EVENTS_SOCKET`, else
 * `agent-lcars/events.sock` under `XDG_RUNTIME_DIR`, else under
 * `/run/user/<uid>` when it exists. `undefined` when the user has no
 * runtime directory, which only a systemd user session provides reliably.
 */
export function eventsSocketPath(
  env: NodeJS.ProcessEnv,
  uid: number | null = process.getuid?.() ?? null,
  isDirectory: (directory: string) => boolean = (directory) => {
    try {
      return fs.statSync(directory).isDirectory();
    } catch {
      return false;
    }
  },
): string | undefined {
  const configured = env['LCARS_EVENTS_SOCKET']?.trim();
  if (configured) return configured;
  const userRuntime = uid === null ? undefined : `/run/user/${uid}`;
  const runtime =
    env['XDG_RUNTIME_DIR']?.trim() ||
    (userRuntime && isDirectory(userRuntime) ? userRuntime : undefined);
  return runtime
    ? path.join(runtime, EVENTS_SOCKET_DIRECTORY, EVENTS_SOCKET_FILE)
    : undefined;
}

export const localRequestSchema = z.discriminatedUnion('op', [
  agentEventSubscriptionRequestSchema.extend({
    version: z.literal(1),
    op: z.literal('subscribe'),
    sessionId: agentEventSessionIdSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    op: z.literal('list'),
    /** Absent: every subscription on this host. */
    sessionId: agentEventSessionIdSchema.optional(),
  }),
  z.strictObject({
    version: z.literal(1),
    op: z.literal('unsubscribe'),
    id: agentEventSubscriptionIdSchema,
  }),
]);
export type LocalRequest = z.infer<typeof localRequestSchema>;

export const LOCAL_ERROR_CODES = [
  /** The agent has no agent-events key on this host. */
  'not-configured',
  /** The request failed validation, locally or in the console (400). */
  'invalid-request',
  /** The console refused the host's identity (401). */
  'unauthorized',
  /** The session is not live on this host by its telemetry (403). */
  'forbidden',
  /** No such subscription on this host (404). */
  'not-found',
  /** Too many subscriptions for the session (409). */
  'conflict',
  /** The console could not be reached or failed; try again. */
  'unavailable',
] as const;
export type LocalErrorCode = (typeof LOCAL_ERROR_CODES)[number];

export const localResponseSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    subscription: agentEventSubscriptionViewSchema,
  }),
  z.strictObject({
    ok: z.literal(true),
    subscriptions: z.array(agentEventSubscriptionViewSchema),
  }),
  z.strictObject({
    ok: z.literal(true),
    deleted: agentEventSubscriptionIdSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.enum(LOCAL_ERROR_CODES),
    message: z.string().max(1024),
  }),
]);
export type LocalResponse = z.infer<typeof localResponseSchema>;

export type LocalCallResult =
  | { readonly ok: true; readonly response: LocalResponse }
  | {
      readonly ok: false;
      /**
       * - `not-running`: nothing listens on the socket.
       * - `unsafe-socket`: the socket is not this user's own.
       * - `timeout`: the agent did not answer in time.
       * - `bad-response`: the answer was not one.
       */
      readonly reason:
        'not-running' | 'unsafe-socket' | 'timeout' | 'bad-response';
    };

/** Sends one request to the delivery agent and reads its answer. */
export function callEventsAgent(
  socketPath: string,
  request: LocalRequest,
  options: {
    readonly timeoutMs?: number;
    readonly uid?: number | null;
    readonly lstat?: (filePath: string) => fs.Stats;
  } = {},
): Promise<LocalCallResult> {
  const uid =
    options.uid === undefined ? (process.getuid?.() ?? null) : options.uid;
  const lstat = options.lstat ?? fs.lstatSync;
  let stat: fs.Stats;
  try {
    stat = lstat(socketPath);
  } catch {
    return Promise.resolve({ ok: false, reason: 'not-running' });
  }
  // Talk only to a socket this user made: a request names a session.
  if (!stat.isSocket() || (uid !== null && stat.uid !== uid)) {
    return Promise.resolve({ ok: false, reason: 'unsafe-socket' });
  }
  return new Promise((resolve) => {
    let settled = false;
    let answer = '';
    const socket = net.connect(socketPath);
    const settle = (result: LocalCallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => settle({ ok: false, reason: 'timeout' }),
      options.timeoutMs ?? 30_000,
    );
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk: string) => {
      answer += chunk;
      const end = answer.indexOf('\n');
      if (end < 0) {
        if (answer.length > MAX_LOCAL_LINE_BYTES) {
          settle({ ok: false, reason: 'bad-response' });
        }
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(answer.slice(0, end));
      } catch {
        settle({ ok: false, reason: 'bad-response' });
        return;
      }
      const response = localResponseSchema.safeParse(parsed);
      settle(
        response.success
          ? { ok: true, response: response.data }
          : { ok: false, reason: 'bad-response' },
      );
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      settle({
        ok: false,
        reason:
          error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
            ? 'not-running'
            : 'bad-response',
      });
    });
    socket.on('close', () => settle({ ok: false, reason: 'bad-response' }));
  });
}
